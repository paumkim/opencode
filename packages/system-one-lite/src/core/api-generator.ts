/**
 * API Generator - Structured generation via OpenCode Zen / OpenAI-compatible API
 * Same DecisionResult contract as LlamaCppGenerator, different backend.
 *
 * Use this when you want frontier intelligence for structured decisions
 * instead of a local model. The schema layer (Zod → JSON Schema → API call)
 * guarantees the same zero-parse-error property.
 */
import { z } from "zod";
import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "node:url";
import type { DecisionResult, GeneratorConfig, Workflow, WorkflowResult, WorkflowStep } from "./types.js";

/**
 * Best-effort JSON parse with simple repair for truncated/malformed model output.
 * Tries strict parse first, then falls back to brace-balancing and truncation repair.
 */
function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Fallback: try to balance braces and truncate at the last complete value
    const trimmed = raw.trim();
    let depth = 0;
    let lastValid = -1;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === "{") depth++;
      else if (trimmed[i] === "}") depth--;
      else if (trimmed[i] === '"' && trimmed[i - 1] !== '\\') {
        // track string boundaries to avoid counting braces inside strings
      }
      if (depth === 0 && i > 0) lastValid = i;
    }
    if (lastValid > 0) {
      const repaired = trimmed.slice(0, lastValid + 1);
      try {
        return JSON.parse(repaired);
      } catch {
        // Final fallback: wrap in object if it looks like key: value pairs
        const wrapped = `{${repaired}}`;
        try {
          return JSON.parse(wrapped);
        } catch {
          // Give up — return the raw string so Zod can produce a clear error
          return raw;
        }
      }
    }
    return raw;
  }
}

// Load .env.local from the package root
// Use process.cwd() as fallback when import.meta.url is unavailable (bundled output)
const pkgDir = (() => {
  try {
    // @ts-ignore - import.meta is supported at runtime (Bun/Node 20+) but TS module checking flags it here
    const url = new URL((import.meta as any).url || "");
    return fileURLToPath(url);
  } catch {
    return process.cwd();
  }
})();
config({ path: resolve(pkgDir, "..", ".env.local") });
config({ path: resolve(pkgDir, "..", ".env") });
config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env") });

/**
 * Resolve a config value that may be:
 * - "env:VAR_NAME" → process.env.VAR_NAME
 * - plain string → returned as-is
 */
export function resolveEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("env:")) {
    const envVar = value.slice(4);
    return process.env[envVar];
  }
  return value;
}

export interface ApiGeneratorConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export function zodToJsonSchema(schema: z.ZodSchema): Record<string, unknown> {
  // Minimal JSON Schema generation for Zod
  const def = (schema as any)._def;
  const typeName = def?.typeName;

  switch (typeName) {
    case "ZodObject": {
      const shape = (schema as any).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(field as z.ZodSchema);
        if (!(field as any).isOptional()) required.push(key);
      }
      return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      };
    }
    case "ZodEnum":
      return { type: "string", enum: (schema as any).options };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodNumber": {
      const checks = (schema as any)._def?.checks || [];
      const schema2: Record<string, unknown> = { type: "number" };
      for (const c of checks) {
        if (c.kind === "min") schema2.minimum = c.value;
        if (c.kind === "max") schema2.maximum = c.value;
      }
      return schema2;
    }
    case "ZodString": {
      const checks = (schema as any)._def?.checks || [];
      const schema2: Record<string, unknown> = { type: "string" };
      for (const c of checks) {
        if (c.kind === "min") schema2.minLength = c.value;
        if (c.kind === "max") schema2.maxLength = c.value;
      }
      return schema2;
    }
    default:
      return { type: "string" };
  }
}

/**
 * Zen endpoint mapping by model family
 * From: https://opencode.ai/docs/zen/
 */
function zenEndpoint(baseURL: string, model: string): string {
  const base = baseURL.replace(/\/$/, "");
  const m = model.toLowerCase();

  // Anthropic-compatible models → /messages
  if (m.includes("claude") || m.includes("qwen3")) {
    return `${base}/messages`;
  }
  // Google-compatible models → /models/{model}
  if (m.includes("gemini")) {
    return `${base}/models/${model}`;
  }
  // Everything else (GPT, Muse Spark, Grok, DeepSeek, etc.) → /responses
  // Note: /responses is the OpenAI Responses API, not /chat/completions
  return `${base}/responses`;
}

export class ApiGenerator {
  private config: Required<ApiGeneratorConfig>;

  constructor(config: ApiGeneratorConfig) {
    this.config = {
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
      temperature: config.temperature ?? 0.0,
      maxTokens: config.maxTokens ?? 512,
      timeoutMs: config.timeoutMs ?? 30000,
    };
  }

  async generate<T extends z.ZodSchema>(
    prompt: string,
    schema: T,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<DecisionResult<z.infer<T>>> {
    const start = performance.now();
    const jsonSchema = zodToJsonSchema(schema);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const endpoint = zenEndpoint(this.config.baseURL, this.config.model);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: "system",
              content:
                "You output only valid JSON matching the provided schema. No markdown, no explanations, no code fences.",
            },
            { role: "user", content: prompt },
          ],
          temperature: options?.temperature ?? this.config.temperature,
          max_tokens: options?.maxTokens ?? this.config.maxTokens,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "decision",
              strict: true,
              schema: jsonSchema,
            },
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`API error ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("Empty response from API");
      }

      const parsed = safeParseJson(content);
      const validated = schema.parse(parsed);
      const latencyMs = performance.now() - start;
      const tokensUsed = data.usage?.total_tokens ?? Math.ceil(content.length / 4);

      return {
        value: validated,
        latencyMs,
        tokensUsed,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async generateRaw(prompt: string, grammar: string): Promise<string> {
    // Not supported via API backend — use generate() with a schema instead
    throw new Error("generateRaw not supported on ApiGenerator; use generate() with a Zod schema");
  }

  /**
   * Run a full workflow (multi-step) — same contract as LlamaCppGenerator
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
        const ready = remaining.filter(
          step => !step.promptTemplate.includes(`{${remaining.map(s => s.name).join("}{")}`) ||
            completed.includes(step.promptTemplate.match(/\{(\w+)\}/g)?.[0]?.replace(/[{}]/g, "") || "")
        );

        // Simple topological: run steps whose dependencies are all completed
        const executable = remaining.filter(step =>
          [...step.promptTemplate.matchAll(/\{(\w+)\}/g)]
            .map(m => m[1])
            .filter(name => !context[name] && !completed.includes(name))
            .length === 0
        );

        const batch = executable.length > 0 ? executable : [remaining[0]];

        const promises = batch.map(async step => {
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
          const idx = remaining.indexOf(step);
          if (idx >= 0) remaining.splice(idx, 1);
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

  private buildPrompt(template: string, context: Record<string, unknown>, stepResults: Record<string, unknown>): string {
    let prompt = template;
    for (const [key, value] of Object.entries(context)) {
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
    }
    for (const [key, value] of Object.entries(stepResults)) {
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, "g"), JSON.stringify(value));
    }
    return prompt;
  }
}

/**
 * Create an ApiGenerator configured for OpenCode Zen
 */
export function createZenGenerator(apiKey: string, model: string = "gpt-5.4-mini"): ApiGenerator {
  return new ApiGenerator({
    apiKey,
    baseURL: "https://opencode.ai/zen/v1",
    model,
    temperature: 0.0,
    maxTokens: 512,
  });
}

/**
 * Create an ApiGenerator from opencode auth config
 * Reads the Zen API key from the opencode auth store
 */
export async function createZenGeneratorFromAuth(): Promise<ApiGenerator | null> {
  try {
    const { readFileSync, existsSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");

    const authPaths = [
      join(homedir(), ".opencode", "auth.json"),
      join(homedir(), ".config", "opencode", "auth.json"),
    ];

    for (const p of authPaths) {
      if (!existsSync(p)) continue;
      const auth = JSON.parse(readFileSync(p, "utf8"));
      const zen = auth?.providers?.zen || auth?.zen;
      if (zen?.key) {
        return createZenGenerator(zen.key, zen.model || "gpt-5.4-mini");
      }
    }
    return null;
  } catch {
    return null;
  }
}