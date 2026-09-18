/**
 * CLI Generator - Structured generation via `opencode run`
 * Uses the exact same auth mechanism as the opencode CLI.
 * No API key management — the CLI handles it.
 */
import { spawn } from "child_process";
import { z } from "zod";
import type { DecisionResult, Workflow, WorkflowResult, WorkflowStep } from "./types.js";

/**
 * Minimal JSON Schema generation for Zod schemas
 */
function zodToJsonSchema(schema: z.ZodSchema): Record<string, unknown> {
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

export interface CliGeneratorConfig {
  model: string;
  timeoutMs?: number;
  cwd?: string;
}

export class CliGenerator {
  private config: Required<CliGeneratorConfig>;

  constructor(config: CliGeneratorConfig) {
    this.config = {
      model: config.model,
      timeoutMs: config.timeoutMs ?? 60000,
      cwd: config.cwd ?? process.cwd(),
    };
  }

  async generate<T extends z.ZodSchema>(
    prompt: string,
    schema: T,
    _options?: { temperature?: number; maxTokens?: number }
  ): Promise<DecisionResult<z.infer<T>>> {
    const start = performance.now();
    const jsonSchema = zodToJsonSchema(schema);
    const schemaJson = JSON.stringify(jsonSchema);

    // Embed system instructions in the prompt — `opencode run` has no --system flag
    const fullPrompt =
      `You output ONLY valid JSON matching this JSON Schema. No markdown, no explanations, no code fences.\n\n` +
      `JSON Schema:\n${schemaJson}\n\n` +
      `User request:\n${prompt}`;

    const output = await this.runCli(fullPrompt);
    const latencyMs = performance.now() - start;

    // Extract JSON from output
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`No JSON found in CLI output: ${output.slice(0, 200)}`);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const validated = schema.parse(parsed);

    return {
      value: validated,
      latencyMs,
      tokensUsed: Math.ceil(output.length / 4),
    };
  }

  async generateRaw(prompt: string, grammar: string): Promise<string> {
    throw new Error("generateRaw not supported on CliGenerator");
  }

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

private runCli(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "run",
        "-m", this.config.model,
        prompt,
      ];

      const child = spawn("opencode", args, {
        cwd: this.config.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data) => { stdout += data.toString(); });
      child.stderr?.on("data", (data) => { stderr += data.toString(); });

      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`opencode run exited ${code}: ${stderr.slice(0, 300) || stdout.slice(0, 300)}`));
        }
      });

      child.on("error", (err) => {
        reject(new Error(`Failed to spawn opencode: ${err.message}`));
      });

      setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("opencode run timeout"));
      }, this.config.timeoutMs);
    });
  }
}

/**
 * Create a CLI generator for a Zen model
 */
export function createCliGenerator(model: string): CliGenerator {
  return new CliGenerator({ model, timeoutMs: 60000 });
}