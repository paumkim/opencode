/**
 * Kilo API Generator - Structured generation via Kilo AI gateway
 * Direct HTTP backend that calls https://api.kilo.ai/api/gateway/responses
 * Faster and lighter than shelling out to `opencode run` via CLI.
 *
 * Same DecisionResult contract as ApiGenerator and LlamaCppGenerator.
 */
import { z } from "zod";
import type { DecisionResult, Workflow, WorkflowResult, WorkflowStep } from "./types.js";

export const KILO_BASE_URL = "https://api.kilo.ai/api/gateway";

/**
 * Resolve the Kilo API key from env or direct value.
 * Reads KILO_API_KEY environment variable.
 */
export function resolveKiloApiKey(apiKey?: string): string | undefined {
  if (apiKey) return apiKey;
  return process.env.KILO_API_KEY;
}

export interface KiloGeneratorConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * Minimal JSON Schema generation for Zod schemas
 * Matches ApiGenerator exactly.
 */
export function zodToJsonSchema(schema: z.ZodSchema): Record<string, unknown> {
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
      const s: Record<string, unknown> = { type: "number" };
      for (const c of checks) {
        if (c.kind === "min") s.minimum = c.value;
        if (c.kind === "max") s.maximum = c.value;
      }
      return s;
    }
    case "ZodString": {
      const checks = (schema as any)._def?.checks || [];
      const s: Record<string, unknown> = { type: "string" };
      for (const c of checks) {
        if (c.kind === "min") s.minLength = c.value;
        if (c.kind === "max") s.maxLength = c.value;
      }
      return s;
    }
    default:
      return { type: "string" };
  }
}

/**
 * Best-effort JSON parse with simple repair for truncated/malformed model output.
 * Tries strict parse first, then falls back to brace-balancing and truncation repair.
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

export class KiloGenerator {
  private config: Required<KiloGeneratorConfig>;

  constructor(config: KiloGeneratorConfig) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model,
      baseURL: config.baseURL ?? KILO_BASE_URL,
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
      const endpoint = `${this.config.baseURL.replace(/\/$/, "")}/responses`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          input: [
            {
              role: "system",
              content:
                "You output only valid JSON matching the provided schema. No markdown, no explanations, no code fences.",
            },
            { role: "user", content: prompt },
          ],
          temperature: options?.temperature ?? this.config.temperature,
          max_output_tokens: options?.maxTokens ?? this.config.maxTokens,
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
        if (response.status === 401) {
          throw new Error(
            `Kilo API authentication failed (401). Check that KILO_API_KEY is set correctly. ${body.slice(0, 100)}`
          );
        }
        if (response.status === 429) {
          throw new Error(
            `Kilo API rate limited (429). Retry after delay. ${body.slice(0, 100)}`
          );
        }
        throw new Error(`Kilo API error ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = (await response.json()) as {
        output?: Array<{
          type?: string;
          content?: Array<{ type?: string; text?: string }>;
        }>;
        usage?: { total_tokens?: number };
      };

      // OpenAI Responses API format: output is an array of items
      const outputItems = data.output ?? [];
      let content = "";
      for (const item of outputItems) {
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === "output_text" && part.text) {
              content = part.text;
              break;
            }
          }
        }
        if (content) break;
      }

      // Fallback: try choices format (some Kilo models may return OpenAI-compatible format)
      if (!content && (data as any).choices?.[0]?.message?.content) {
        content = (data as any).choices[0].message.content;
      }

      if (!content) {
        throw new Error("Empty response from Kilo API");
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
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === "AbortError") {
          throw new Error(`Kilo API request timed out after ${this.config.timeoutMs}ms`);
        }
        if (err.message.includes("Failed to fetch") || err.message.includes("ECONNREFUSED")) {
          throw new Error(`Kilo API network error: ${err.message}`);
        }
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async generateRaw(prompt: string, grammar: string): Promise<string> {
    // Not supported via Kilo API backend — use generate() with a schema instead
    throw new Error("generateRaw not supported on KiloGenerator; use generate() with a Zod schema");
  }

  /**
   * Run a full workflow (multi-step) — same contract as ApiGenerator
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
 * Create a KiloGenerator with default model `kilo-auto/free`
 */
export function createKiloGenerator(
  apiKey: string,
  model: string = "kilo-auto/free",
  baseURL?: string
): KiloGenerator {
  return new KiloGenerator({
    apiKey,
    model,
    baseURL,
    temperature: 0.0,
    maxTokens: 512,
    timeoutMs: 30000,
  });
}
