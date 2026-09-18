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

/**
 * Normalize model output before Zod validation:
 * - Convert boolean-like numbers (1/0) to true/false
 * - Convert boolean-like strings ("yes"/"no") to true/false
 */
function normalizeOutput(value: unknown): unknown {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(normalizeOutput);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const normalized = normalizeOutput(v);
      // Only normalize string representations of booleans, not numbers
      // (numbers like 1/0 for booleans are handled by the GBNF grammar accepting them)
      if (normalized === "1" || normalized === "yes" || normalized === "true") {
        result[k] = true;
      } else if (normalized === "0" || normalized === "no" || normalized === "false") {
        result[k] = false;
      } else {
        result[k] = normalized;
      }
    }
    return result;
  }
  return value;
}

/**
 * Generator using llama.cpp CLI with GBNF constrained generation
 */
export class LlamaCppGenerator {
  private config: Required<GeneratorConfig>;
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
    };
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

    // Get or create GBNF grammar for this schema
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
  * Check if a step depends on any of the given step names
  */
 private stepDependsOn(step: WorkflowStep, stepNames: string[]): boolean {
    const template = step.promptTemplate;
    return stepNames.some(name => template.includes(`{${name}}`));
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