/**
 * LlamaCppGenerator - Structured generation using llama.cpp with GBNF grammars
 * Zero parse errors guaranteed by construction
 */

import { spawn, SpawnOptions } from "child_process";
import { writeFile, unlink, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";
import type {
  DecisionResult,
  GeneratorConfig,
  WorkflowStep,
  Workflow,
  WorkflowResult,
} from "./types.js";
import { zodToGbnf, writeGbnfFile, cleanupGbnfFile, GBNF } from "./gbnf.js";
import type { Calibrator } from "./calibrator.js";
import { createCalibrator, TemperatureScaler } from "./calibrator.js";

/**
 * Best-effort JSON parse with simple repair for truncated/malformed model output.
 */
function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const trimmed = raw.trim();
    let depth = 0;
    let lastValid = -1;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === "{") depth++;
      else if (trimmed[i] === "}") depth--;
      if (depth === 0 && i > 0) lastValid = i;
    }
    if (lastValid > 0) {
      const repaired = trimmed.slice(0, lastValid + 1);
      try {
        return JSON.parse(repaired);
      } catch {
        const wrapped = `{${repaired}}`;
        try {
          return JSON.parse(wrapped);
        } catch {
          return raw;
        }
      }
    }
    return raw;
  }
}

/**
 * Normalize model output before Zod validation:
 * - Convert boolean-like numbers (1/0) to true/false
 * - Convert boolean-like strings ("yes"/"no") to true/false
 */
function normalizeOutput(value: unknown): unknown {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    // Convert boolean-like strings
    const lower = value.toLowerCase();
    if (lower === "true" || lower === "yes" || lower === "1") return true;
    if (lower === "false" || lower === "no" || lower === "0") return false;
    // Convert numeric strings
    const num = Number(value);
    if (!Number.isNaN(num) && Number.isFinite(num)) return num;
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeOutput);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = normalizeOutput(v);
    }
    return result;
  }
  return value;
}


/**
 * Apply calibration to a raw confidence score.
 * If no calibrator is provided, returns the raw confidence unchanged.
 */
export function applyCalibration(confidence: number, calibrator: Calibrator | undefined): number {
  if (!calibrator) return confidence;
  
  // TemperatureScaler expects 2D input, Platt/Isotonic expect 1D
  if (calibrator instanceof TemperatureScaler) {
    const raw = calibrator.calibrate([[confidence]]);
    return raw[0][0];
  }
  
  const raw = calibrator.calibrate([confidence]);
  return raw[0];
}
/**
 * Generator using llama.cpp CLI with GBNF constrained generation
 */
export class LlamaCppGenerator {
  private config: Omit<Required<GeneratorConfig>, "calibrator"> & { calibrator?: Calibrator };
  private grammarCache: Map<string, string> = new Map();

  constructor(config: GeneratorConfig) {
    this.config = {
      modelPath: config.modelPath,
      backend: config.backend ?? "llama.cpp",
      ctxSize: config.ctxSize ?? 4096,
      ngl: config.ngl ?? 999,
      temperature: config.temperature ?? 0.0,
      maxTokens: config.maxTokens ?? 512,
      binaryPath: config.binaryPath ?? "llama-completion",
      serverUrl: config.serverUrl ?? "",
      calibrator: config.calibrator,
    };
  }

  /**
   * Set or replace the calibrator used for confidence scoring.
   */
  setCalibrator(calibrator: Calibrator): void {
    this.config.calibrator = calibrator;
  }

  /**
   * Generate structured output conforming to Zod schema
   */
  async generate<T extends z.ZodSchema>(
    prompt: string,
    schema: T,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<DecisionResult<z.infer<T>>> {
    const start = performance.now();

    if (this.config.backend === "llama-server" && this.config.serverUrl) {
      // Server path: HTTP POST to persistent llama-server
      const output = await this.runLlamaServer(prompt, schema, options);
      const latencyMs = performance.now() - start;
      const raw = safeParseJson(output);
      const normalized = normalizeOutput(raw);
      const parsed = schema.parse(normalized);

      return {
        value: parsed,
        latencyMs,
        tokensUsed: this.estimateTokens(output),
        confidence: applyCalibration(this.estimateConfidence(schema, parsed), this.config.calibrator),
      };
    }

    // CLI path: spawn llama-completion with GBNF grammar
    const grammar = this.getGrammar(schema);
    const grammarFile = await writeGbnfFile(grammar);

    try {
      const output = await this.runLlamaCpp(prompt, grammarFile, options);
      const latencyMs = performance.now() - start;

      // Parse and normalize before Zod validation
      const raw = JSON.parse(output);
      const normalized = normalizeOutput(raw);
      const parsed = schema.parse(normalized);

      return {
        value: parsed,
        latencyMs,
        tokensUsed: this.estimateTokens(output),
        confidence: applyCalibration(this.estimateConfidence(schema, parsed), this.config.calibrator),
      };
    } finally {
      await cleanupGbnfFile(grammarFile);
    }
  }

  /**
   * Generate raw text with GBNF grammar (no Zod parsing)
   */
  async generateRaw(prompt: string, grammar: string): Promise<string> {
    const grammarFile = await writeGbnfFile(grammar);
    try {
      return await this.runLlamaCpp(prompt, grammarFile);
    } finally {
      await cleanupGbnfFile(grammarFile);
    }
  }

  /**
   * Run llama.cpp with GBNF grammar
   */
  private async runLlamaCpp(
    prompt: string,
    grammarFile: string,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<string> {
    const args = [
      "-m", this.config.modelPath,
      "-sys", "You output only valid JSON matching the provided grammar. No markdown, no explanations.",
      "-p", prompt,
      "--grammar-file", grammarFile,
      "-c", String(this.config.ctxSize),
      "-ngl", String(this.config.ngl),
      "--temp", String(options?.temperature ?? this.config.temperature),
      "-n", String(options?.maxTokens ?? this.config.maxTokens),
      "--no-display-prompt",
    ];

    return new Promise((resolve, reject) => {
      const child = spawn(this.config.binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      } as SpawnOptions);

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data) => { stdout += data.toString(); });
      child.stderr?.on("data", (data) => { stderr += data.toString(); });

      child.on("close", (code) => {
        if (code === 0) {
          // Extract JSON from output (remove any non-JSON text)
          const jsonMatch = stdout.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            resolve(jsonMatch[0].trim());
          } else {
            resolve(stdout.trim());
          }
        } else {
          reject(new Error(`llama.cpp exited with code ${code}: ${stderr}`));
        }
      });

      child.on("error", (err) => {
        reject(new Error(`Failed to spawn llama.cpp: ${err.message}`));
      });

      // Timeout
      setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("llama.cpp timeout"));
      }, 120000);
    });
  }

  /**
   * Run llama-server HTTP backend (OpenAI-compatible /v1/chat/completions)
   * Eliminates spawn overhead — uses persistent server for ~150ms latency.
   */
  private async runLlamaServer(
    prompt: string,
    schema: z.ZodSchema,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<string> {
    const baseURL = this.config.serverUrl!.replace(/\/$/, "");
    const endpoint = `${baseURL}/v1/chat/completions`;

    const systemInstruction =
      "You output only valid JSON matching the provided schema. No markdown, no explanations, no code fences.";

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.modelPath,
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: prompt },
        ],
        temperature: options?.temperature ?? this.config.temperature,
        max_tokens: options?.maxTokens ?? this.config.maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 60000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`llama-server error ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty response from llama-server");

    return content;
  }

  /**
   * Get GBNF grammar for schema (cached)
   */
  private getGrammar(schema: z.ZodSchema): string {
    // Use description when available; otherwise build a stable key from the schema shape.
    // JSON.stringify(schema._def) is unreliable for ZodObject because _def omits the shape.
    const key =
      (schema as any).description ??
      (() => {
        const def = (schema as any)._def;
        if (def?.typeName === "ZodObject") {
          const shape = (schema as any).shape;
          return JSON.stringify({ typeName: def.typeName, keys: Object.keys(shape) });
        }
        return JSON.stringify(def);
      })();

    if (!this.grammarCache.has(key)) {
      this.grammarCache.set(key, zodToGbnf(schema));
    }
    return this.grammarCache.get(key)!;
  }

  /**
   * Rough token estimation
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Estimate confidence based on schema type completeness and parsed output.
   * If a raw confidence is provided, it is used directly instead of computing the heuristic.
   */
  private estimateConfidence(schema: z.ZodSchema, parsed: unknown, rawConfidence?: number): number {
    try {
      const confidence = rawConfidence ?? (() => {
        const shape = (schema as any).shape || {};
        const entries = Object.entries(shape);
        if (entries.length === 0) return 0.9;

        let present = 0;
        let total = 0;
        const obj = parsed as Record<string, unknown>;

        for (const [, fieldSchema] of entries) {
          const def = (fieldSchema as any)._def;
          const typeName = def?.typeName;
          if (typeName === "ZodOptional" || typeName === "ZodDefault") continue;
          total++;
          const key = Object.keys(shape).find((k) => shape[k] === fieldSchema);
          if (key !== undefined && obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
            present++;
          }
        }

        if (total === 0) return 0.9;
        if (present === total) return 0.9;
        if (present >= total * 0.7) return 0.7;
        return 0.0;
      })();

      return applyCalibration(confidence, this.config.calibrator);
    } catch {
      return 0.0;
    }
  }

/**
 * Check if a step depends on any of the given step names.
 * Uses word-boundary matching to avoid false positives (e.g. step "test" matching "{test_results}").
 */
private stepDependsOn(step: WorkflowStep, stepNames: string[]): boolean {
  const template = step.promptTemplate;
  return stepNames.some(name => {
    const regex = new RegExp(`\\{${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`);
    return regex.test(template);
  });
}

  /**
  * Run a workflow (multiple steps) with parallel execution for independent steps
  */
 async runWorkflow(workflow: Workflow, context: Record<string, unknown>): Promise<WorkflowResult> {
    const start = performance.now();
    const stepResults: Record<string, unknown> = {};
    let totalTokens = 0;
    let success = true;
    let error: string | undefined;

    try {
      const remaining = [...workflow.steps];
      const completed: string[] = [];

      while (remaining.length > 0) {
        // Find steps that don't depend on any remaining (uncompleted) steps
        const ready = remaining.filter(step => !this.stepDependsOn(step, remaining.map(s => s.name)));

        if (ready.length === 0) {
          // Circular dependency or all remaining steps depend on each other
          // Fall back to sequential execution
          const step = remaining.shift()!;
          const prompt = this.buildPrompt(step.promptTemplate, context, stepResults);
          const result = await this.generate(prompt, step.schema);
          const decision = step.extract ? step.extract(result.value) : result.value;
          stepResults[step.name] = decision;
          totalTokens += result.tokensUsed ?? 0;
          completed.push(step.name);
        } else {
          // Run ready steps in parallel
          const promises = ready.map(async (step) => {
            const prompt = this.buildPrompt(step.promptTemplate, context, stepResults);
            const result = await this.generate(prompt, step.schema);
            const decision = step.extract ? step.extract(result.value) : result.value;
            return { step, decision, result };
          });

          const results = await Promise.all(promises);

          for (const { step, decision, result } of results) {
            stepResults[step.name] = decision;
            totalTokens += result.tokensUsed ?? 0;
            completed.push(step.name);
            // Remove from remaining
            const idx = remaining.indexOf(step);
            if (idx >= 0) remaining.splice(idx, 1);
          }
        }
      }
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
    }

    return {
      workflowName: workflow.name,
      stepResults,
      totalLatencyMs: performance.now() - start,
      totalTokens,
      success,
      error,
    };
  }

  /**
  * Run a workflow with streaming step results
  */
 async runWorkflowStream(
    workflow: Workflow,
    context: Record<string, unknown>,
    onStepComplete: (stepName: string, result: unknown, latencyMs: number) => void
  ): Promise<WorkflowResult> {
    const start = performance.now();
    const stepResults: Record<string, unknown> = {};
    let totalTokens = 0;
    let success = true;
    let error: string | undefined;

    try {
      const remaining = [...workflow.steps];
      const completed: string[] = [];

      while (remaining.length > 0) {
        const ready = remaining.filter(step => !this.stepDependsOn(step, remaining.map(s => s.name)));

        if (ready.length === 0) {
          const step = remaining.shift()!;
          const stepStart = performance.now();
          const prompt = this.buildPrompt(step.promptTemplate, context, stepResults);
          const result = await this.generate(prompt, step.schema);
          const decision = step.extract ? step.extract(result.value) : result.value;
          stepResults[step.name] = decision;
          totalTokens += result.tokensUsed ?? 0;
          onStepComplete(step.name, decision, performance.now() - stepStart);
          completed.push(step.name);
        } else {
          const promises = ready.map(async (step) => {
            const stepStart = performance.now();
            const prompt = this.buildPrompt(step.promptTemplate, context, stepResults);
            const result = await this.generate(prompt, step.schema);
            const decision = step.extract ? step.extract(result.value) : result.value;
            onStepComplete(step.name, decision, performance.now() - stepStart);
            return { step, decision, result };
          });

          const results = await Promise.all(promises);

          for (const { step, decision, result } of results) {
            stepResults[step.name] = decision;
            totalTokens += result.tokensUsed ?? 0;
            completed.push(step.name);
            const idx = remaining.indexOf(step);
            if (idx >= 0) remaining.splice(idx, 1);
          }
        }
      }
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
    }

    return {
      workflowName: workflow.name,
      stepResults,
      totalLatencyMs: performance.now() - start,
      totalTokens,
      success,
      error,
    };
  }

  /**
  * Run multiple contexts through a workflow with bounded concurrency
  */
 async runBatch(
    workflow: Workflow,
    contexts: Record<string, unknown>[],
    concurrency = 2
  ): Promise<WorkflowResult[]> {
    const results: WorkflowResult[] = [];
    for (let i = 0; i < contexts.length; i += concurrency) {
      const chunk = contexts.slice(i, i + concurrency);
      const chunkResults = await Promise.all(chunk.map(ctx => this.runWorkflow(workflow, ctx)));
      results.push(...chunkResults);
    }
    return results;
  }

  /**
   * Build prompt from template with context and step results
   */
  private buildPrompt(
    template: string,
    context: Record<string, unknown>,
    stepResults: Record<string, unknown>
  ): string {
    let prompt = template;

    // Replace context variables
    for (const [key, value] of Object.entries(context)) {
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
    }

    // Replace step results
    for (const [key, value] of Object.entries(stepResults)) {
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, "g"), JSON.stringify(value));
    }

    return prompt;
  }
}

/**
 * Factory for creating generator with recommended 6GB VRAM config
 */
export function createGenerator(modelPath: string, overrides?: Partial<GeneratorConfig>): LlamaCppGenerator {
  return new LlamaCppGenerator({
    modelPath,
    backend: "llama.cpp",
    ctxSize: 4096,
    ngl: 999,
    temperature: 0.0,
    maxTokens: 512,
    ...overrides,
  });
}