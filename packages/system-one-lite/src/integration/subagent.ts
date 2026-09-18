/**
 * opencode Integration - @system-one subagent
 * Uses System One Lite for structured decisions in workflows
 */

import { z } from "zod";
import { LlamaCppGenerator, createGenerator } from "../core/generator.js";
import { ApiGenerator, createZenGenerator, createZenGeneratorFromAuth, resolveEnv } from "../core/api-generator.js";
import { CliGenerator, createCliGenerator } from "../core/cli-generator.js";
import {
  createParallelPrompt,
  buildParallelPromptText,
  buildParallelSchema,
  parseParallelOutput,
  estimateParallelConfidence,
  ISSUE_TRIAGE_PROMPT,
  CODE_REVIEW_PROMPT,
  RELEASE_READINESS_PROMPT,
} from "../core/parallel.js";
import {
  WorkflowRunner,
  ISSUE_TRIAGE_WORKFLOW,
  CODE_REVIEW_WORKFLOW,
  RELEASE_READINESS_WORKFLOW,
} from "../eval/workflow.js";
import { buildPools, type Pools } from "../core/pools.js";
import { correctSpelling, resolveFollowUp, type PreprocessResult, type PendingQuestion } from "../core/preprocess.js";
import { generateTraceId, type TurnTrace, type ArgTrace, type QuestionTrace } from "../core/trace.js";
import { toolRegistry, type SingleStepAdapter, type MultiStepAdapter, type ToolResult, type QuestionDefinition } from "../tools/index.js";
import type { GeneratorConfig, Workflow, WorkflowResult } from "../core/types.js";

/**
 * Pending action from a previous turn.
 */
export interface PendingAction {
  question?: PendingQuestion;
}

/**
  * Model capability descriptor
  */
 export interface ModelCapabilities {
   path: string;
   name: string;
   sizeGB: number;
   vramGB: number;
   speed: "fast" | "medium" | "slow";
   accuracy: "low" | "medium" | "high";
   strengths: string[];
 }

  /**
  * System One Subagent Configuration
  */
export interface SystemOneConfig {
  modelPath?: string;
  backend?: "llama.cpp" | "llama-server" | "api" | "cli";
  ctxSize?: number;
  ngl?: number;
  temperature?: number;
  maxTokens?: number;
  binaryPath?: string;
  serverUrl?: string;
  defaultWorkflow?: string;
  models?: ModelCapabilities[];
  autoSelectModel?: boolean;
  apiKey?: string;
  apiModel?: string;
  apiBaseURL?: string;
  cliModel?: string;
}

/**
  * Auto-select the best model for a given workflow
  */
 export class ModelSelector {
   private models: ModelCapabilities[];

   constructor(models: ModelCapabilities[] = []) {
     // Default model registry if none provided
     this.models = models.length > 0 ? models : [
       {
         path: "./models/qwen2.5-3b-instruct-q4_k_m.gguf",
         name: "qwen2.5-3b-instruct",
         sizeGB: 2.4,
         vramGB: 6,
         speed: "fast",
         accuracy: "medium",
         strengths: ["enums", "booleans", "simple classifications", "fast inference"],
       },
       {
         path: "./models/Meta-Llama-3.1-8B-Instruct-Q3_K_M.gguf",
         name: "llama-3.1-8b",
         sizeGB: 4.7,
         vramGB: 8,
         speed: "medium",
         accuracy: "high",
         strengths: ["complex reasoning", "multi-step", "open-ended fields", "nuanced decisions"],
       },
     ];
   }

   /**
    * Score a workflow's complexity (higher = more complex)
    */
   private scoreWorkflowComplexity(workflow: Workflow): number {
     let score = 0;

     // More steps = more complex
     score += workflow.steps.length * 10;

     // Analyze each step's schema
     for (const step of workflow.steps) {
       const schema = step.schema;
       const shape = (schema as any).shape || {};

       for (const [fieldName, fieldSchema] of Object.entries(shape)) {
         const def = (fieldSchema as any)._def;
         const typeName = def?.typeName;

         // Open-ended strings are harder
         if (typeName === "ZodString" && !def?.checks?.some((c: any) => c.kind === "enum")) {
           score += 5;
         }

         // Numbers with wide ranges are harder
         if (typeName === "ZodNumber") {
           const checks = def?.checks || [];
           const hasMin = checks.some((c: any) => c.kind === "min");
           const hasMax = checks.some((c: any) => c.kind === "max");
           if (!hasMin || !hasMax) score += 3; // unconstrained number
         }

         // Objects are harder
         if (typeName === "ZodObject") {
           score += Object.keys(def?.shape || {}).length * 2;
         }
       }
     }

     return score;
   }

   /**
    * Select the best model for a workflow
    */
   select(workflow: Workflow): ModelCapabilities {
     const complexity = this.scoreWorkflowComplexity(workflow);

     // Simple workflows (score < 20): use fast model
     // Medium complexity (20-40): use balanced model
     // Complex workflows (score > 40): use accurate model
     if (complexity < 20) {
       return this.models.find(m => m.speed === "fast") || this.models[0];
     } else if (complexity < 40) {
       // Prefer medium speed with good accuracy
       return this.models.find(m => m.speed === "medium" && m.accuracy === "high") || this.models[1];
     } else {
       return this.models.find(m => m.accuracy === "high") || this.models[this.models.length - 1];
     }
   }

   /**
    * Get all registered models
    */
   getModels(): ModelCapabilities[] {
     return [...this.models];
   }

   /**
    * Register a custom model
    */
   registerModel(model: ModelCapabilities): void {
     this.models.push(model);
   }
 }

 /**
  * System One Subagent - Main entry point for opencode integration
  */
  type Generator = LlamaCppGenerator | ApiGenerator | CliGenerator;

export class SystemOneSubagent {
  private generator: Generator;
  private runner: WorkflowRunner;
  private workflows: Map<string, Workflow> = new Map();
  private parallelPrompts: Map<string, ReturnType<typeof createParallelPrompt>> = new Map();

  constructor(config: SystemOneConfig) {
    const backend = config.backend ?? "llama.cpp";

    if (backend === "cli") {
      // CLI backend — uses `opencode run` with the same auth as the CLI
      this.generator = new CliGenerator({
        model: config.cliModel ?? "opencode/muse-spark-1.3-contributor-free",
        timeoutMs: 60000,
      });
    } else if (backend === "api") {
      // API backend — use frontier model for structured decisions
      const apiKey = resolveEnv(config.apiKey);
      if (!apiKey) {
        throw new Error(
          "API key not found. Set OPENCODE_ZEN_API_KEY in .env.local or pass config.apiKey directly."
        );
      }
      this.generator = new ApiGenerator({
        apiKey,
        baseURL: resolveEnv(config.apiBaseURL) ?? "https://opencode.ai/zen/v1",
        model: resolveEnv(config.apiModel) ?? "gpt-5.4-mini",
        temperature: config.temperature ?? 0.0,
        maxTokens: config.maxTokens ?? 512,
      });
    } else {
      // Local backend — use llama.cpp
      const selector = new ModelSelector(config.models);
      let selectedModelPath = config.modelPath;

      if (config.autoSelectModel && !config.modelPath && config.defaultWorkflow) {
        const workflow = this.getWorkflowDefinition(config.defaultWorkflow);
        if (workflow) {
          const selected = selector.select(workflow);
          selectedModelPath = selected.path;
          console.log(`[system-one] Auto-selected model ${selected.name} for ${config.defaultWorkflow} (complexity: ${this.estimateComplexity(workflow)})`);
        }
      }

      if (!selectedModelPath) {
        throw new Error("modelPath is required when autoSelectModel is false or no defaultWorkflow is set");
      }

      this.generator = createGenerator(selectedModelPath, {
        backend: config.backend,
        ctxSize: config.ctxSize,
        ngl: config.ngl,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        binaryPath: config.binaryPath,
        serverUrl: config.serverUrl,
      });
    }

    this.runner = new WorkflowRunner(this.generator as any);

    // Register built-in workflows
    this.registerWorkflow("issue_triage", ISSUE_TRIAGE_WORKFLOW);
    this.registerWorkflow("code_review", CODE_REVIEW_WORKFLOW);
    this.registerWorkflow("release_readiness", RELEASE_READINESS_WORKFLOW);

    // Register built-in parallel prompts
    this.registerParallelPrompt("issue_triage", ISSUE_TRIAGE_PROMPT);
    this.registerParallelPrompt("code_review", CODE_REVIEW_PROMPT);
    this.registerParallelPrompt("release_readiness", RELEASE_READINESS_PROMPT);
  }

  private getWorkflowDefinition(name: string): Workflow | undefined {
    switch (name) {
      case "issue_triage": return ISSUE_TRIAGE_WORKFLOW;
      case "code_review": return CODE_REVIEW_WORKFLOW;
      case "release_readiness": return RELEASE_READINESS_WORKFLOW;
      default: return undefined;
    }
  }

  private estimateComplexity(workflow: Workflow): number {
    let score = 0;
    score += workflow.steps.length * 10;
    for (const step of workflow.steps) {
      const shape = (step.schema as any).shape || {};
      for (const field of Object.values(shape)) {
        const def = (field as any)._def;
        if (def?.typeName === "ZodString" && !def?.checks?.some((c: any) => c.kind === "enum")) {
          score += 5;
        }
        if (def?.typeName === "ZodNumber") {
          const checks = def?.checks || [];
          if (!checks.some((c: any) => c.kind === "min") || !checks.some((c: any) => c.kind === "max")) {
            score += 3;
          }
        }
        if (def?.typeName === "ZodObject") {
          score += Object.keys(def?.shape || {}).length * 2;
        }
      }
    }
    return score;
  }

  /**
   * Register a custom workflow
   */
  registerWorkflow(name: string, workflow: Workflow): void {
    this.workflows.set(name, workflow);
  }

  /**
   * Register a custom parallel prompt
   */
  registerParallelPrompt(name: string, prompt: ReturnType<typeof createParallelPrompt>): void {
    this.parallelPrompts.set(name, prompt);
  }

  /**
   * Run a workflow by name
   * Prefers the parallel prompt path when available to avoid double parallelism
   * (workflow-step parallelism × batch parallelism) which can exhaust GPU memory.
   */
  async decide(workflowName: string, context: Record<string, unknown>): Promise<WorkflowResult> {
    // If a parallel prompt exists for this workflow, use the single-call path
    const parallelPrompt = this.parallelPrompts.get(workflowName);
    if (parallelPrompt) {
      const start = performance.now();
      try {
        const fullPrompt = buildParallelPromptText(parallelPrompt);
        const promptContext = typeof context.context === "string" ? context.context : "";
        const finalPrompt = promptContext ? `Context:\n${promptContext}\n\n${fullPrompt}` : fullPrompt;
        const schema = buildParallelSchema(parallelPrompt);
        const result = await this.generator.generate(finalPrompt, schema);
        const stepResults = parseParallelOutput(parallelPrompt, JSON.stringify(result.value));
        return {
          workflowName,
          stepResults,
          totalLatencyMs: performance.now() - start,
          totalTokens: result.tokensUsed ?? 0,
          success: true,
        };
      } catch (err) {
        return {
          workflowName,
          stepResults: {},
          totalLatencyMs: performance.now() - start,
          totalTokens: 0,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const workflow = this.workflows.get(workflowName);
    if (!workflow) {
      throw new Error(`Unknown workflow: ${workflowName}. Available: ${Array.from(this.workflows.keys()).join(", ")}`);
    }
    return this.runner.run(workflow, context);
  }

  /**
   * Run a parallel prompt by name
   */
  async decideParallel(promptName: string, context: string = ""): Promise<Record<string, unknown>> {
    const prompt = this.parallelPrompts.get(promptName);
    if (!prompt) {
      throw new Error(`Unknown parallel prompt: ${promptName}. Available: ${Array.from(this.parallelPrompts.keys()).join(", ")}`);
    }

    const fullPrompt = buildParallelPromptText(prompt);
    const finalPrompt = context ? `Context:\n${context}\n\n${fullPrompt}` : fullPrompt;
    const schema = buildParallelSchema(prompt);

    const result = await this.generator.generate(finalPrompt, schema);
    return parseParallelOutput(prompt, JSON.stringify(result.value));
  }

  /**
   * Execute a full turn: preprocess, build pools, run parallel prompt or workflow.
   */
  async executeTurn(
    message: string,
    pendingAction?: PendingAction
  ): Promise<{ result: WorkflowResult; trace: TurnTrace }> {
    const start = performance.now();
    const traceId = generateTraceId();
    const pools = buildPools(message);
    const preprocessed = await correctSpelling(message, pools);
    const resolved = resolveFollowUp(preprocessed.text, pools, pendingAction?.question);
    const finalMessage = resolved.text;

    const prompt = this.parallelPrompts.get("issue_triage") ?? ISSUE_TRIAGE_PROMPT;
    const fullPrompt = buildParallelPromptText(prompt);
    const schema = buildParallelSchema(prompt);
    const finalPrompt = `Context:\n${finalMessage}\n\n${fullPrompt}`;

    let jevCalls: QuestionTrace[][] = [];
    let chosenTool: string | undefined;
    let arguments_: ArgTrace[] | undefined;
    let toolCall: TurnTrace["toolCall"];
    let reply: string | undefined;
    let error: string | undefined;
    let confidence: number | undefined;
    let result: WorkflowResult;

    try {
      const genResult = await this.generator.generate(finalPrompt, schema);
      const parsed = parseParallelOutput(prompt, JSON.stringify(genResult.value));
      confidence = genResult.confidence ?? estimateParallelConfidence(prompt);

      result = {
        workflowName: "issue_triage",
        stepResults: parsed,
        totalLatencyMs: performance.now() - start,
        totalTokens: genResult.tokensUsed ?? 0,
        success: true,
      };

      if (confidence < 0.7) {
        reply = JSON.stringify({ topOptions: parsed, probabilities: { primary: confidence } });
      } else {
        reply = JSON.stringify(parsed);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      result = {
        workflowName: "issue_triage",
        stepResults: {},
        totalLatencyMs: performance.now() - start,
        totalTokens: 0,
        success: false,
        error,
      };
    }

    const trace: TurnTrace = {
      id: traceId,
      originalMessage: message,
      preprocessedMessage: finalMessage,
      pools,
      jevCalls,
      chosenTool,
      arguments: arguments_,
      toolCall,
      reply,
      error,
      latencyMs: performance.now() - start,
      confidence,
    };

    return { result, trace };
  }

  /**
   * Run a tool by server and name.
   */
  async runTool(serverId: string, toolName: string, args: Record<string, any>): Promise<ToolResult> {
    const adapters = toolRegistry.getByServer(serverId);
    const adapter = adapters.find((a) => a.mcpName === toolName);
    if (!adapter) {
      return { content: `No adapter found for ${serverId}/${toolName}`, isError: true };
    }
    // In a real implementation, this would call the MCP client.
    // For now, return a placeholder.
    return { content: { tool: toolName, args }, isError: false };
  }

  /**
   * Run a multi-step adapter.
   */
  async runMultiStep(adapter: MultiStepAdapter, pools: Pools): Promise<ToolResult> {
    return adapter.run(pools, async (questions: QuestionDefinition[]) => {
      // Placeholder: in real use, this would prompt the user/model
      const answers: Record<string, any> = {};
      for (const q of questions) {
        answers[q.key] = q.options?.[Object.keys(q.options)[0]] ?? "";
      }
      return answers;
    });
  }

  /**
   * Confidence-gated routing: if confidence < 0.7, return multiple top options.
   */
  confidenceGate<T>(value: T, confidence: number): { value: T; confidence: number } | { options: T[]; probabilities: Record<string, number> } {
    if (confidence < 0.7) {
      return { options: [value], probabilities: { primary: confidence } };
    }
    return { value, confidence };
  }

  /**
   * Convenience: Classify a GitHub issue
   */
  async classifyIssue(title: string, body: string): Promise<WorkflowResult> {
    return this.decide("issue_triage", {
      context: `You are triaging a GitHub issue for a TypeScript project.\n\nIssue: ${title}\n${body}`,
    });
  }

  /**
   * Convenience: Review a code diff
   */
  async reviewCode(diff: string): Promise<WorkflowResult> {
    return this.decide("code_review", {
      context: `You are reviewing a code change for correctness and security.\n\nCode diff:\n${diff}`,
    });
  }

  /**
   * Convenience: Check release readiness
   */
  async checkRelease(version: string, changelog: string, testResults: string): Promise<WorkflowResult> {
    return this.decide("release_readiness", {
      context: `You are evaluating if a release candidate is ready to ship.\n\nRelease candidate: ${version}\nChanges:\n${changelog}\nTest results:\n${testResults}`,
    });
  }

  /**
   * Get available workflows
   */
  getWorkflows(): string[] {
    return Array.from(this.workflows.keys());
  }

  /**
   * Get available parallel prompts
   */
  getParallelPrompts(): string[] {
    return Array.from(this.parallelPrompts.keys());
  }
}

/**
 * Factory for creating SystemOneSubagent from config
 */
export function createSystemOneAgent(config: SystemOneConfig): SystemOneSubagent {
  return new SystemOneSubagent(config);
}

/**
 * Auto-detect backend from model string and create agent.
 * - Models starting with "kilo/" route to CLI backend via `opencode run`
 * - Everything else routes to local llama.cpp with the given GGUF path
 */
export function createSystemOneAgentFromModel(
  model: string,
  overrides: Omit<SystemOneConfig, "backend" | "modelPath" | "cliModel"> = {}
): SystemOneSubagent {
  if (model.startsWith("kilo/")) {
    return new SystemOneSubagent({
      ...overrides,
      backend: "cli",
      cliModel: model,
    });
  }

  return new SystemOneSubagent({
    ...overrides,
    backend: "llama.cpp",
    modelPath: model,
  });
}

/**
 * Create a SystemOneSubagent backed by OpenCode Zen
 * Uses frontier model for structured decisions — no local GPU needed
 */
export async function createSystemOneZenAgent(
  model: string = "gpt-5.4-mini",
  config: Omit<SystemOneConfig, "backend" | "apiModel" | "apiBaseURL"> = {}
): Promise<SystemOneSubagent> {
  const apiKey = config.apiKey;
  if (!apiKey) {
    throw new Error("OpenCode Zen API key required. Pass config.apiKey or use createSystemOneAgent with backend='api'.");
  }
  return new SystemOneSubagent({
    ...config,
    backend: "api",
    apiModel: model,
    apiBaseURL: "https://opencode.ai/zen/v1",
  });
}

/**
 * Create a SystemOneSubagent backed by the opencode CLI
 * Uses the same auth as `opencode run` — no API key management needed.
 * Best for free models like muse-spark-1.3-contributor-free.
 */
export function createSystemOneCliAgent(
  model: string = "opencode/muse-spark-1.3-contributor-free",
  config: Omit<SystemOneConfig, "backend" | "cliModel"> = {}
): SystemOneSubagent {
  return new SystemOneSubagent({
    ...config,
    backend: "cli",
    cliModel: model,
  });
}

/**
 * opencode agent manifest
 */
export const OPENCODE_AGENT_MANIFEST = {
  name: "system-one",
  description: "Structured decision making with local models (System One Lite)",
  type: "subagent" as const,
  configSchema: z.object({
    modelPath: z.string().describe("Path to GGUF model (optional if autoSelectModel is true)").optional(),
    backend: z.enum(["llama.cpp", "llama-server", "api", "cli"]).default("llama.cpp"),
    ctxSize: z.number().default(4096),
    ngl: z.number().default(999),
    temperature: z.number().default(0.0),
    maxTokens: z.number().default(512),
    binaryPath: z.string().default("llama-completion"),
    serverUrl: z.string().optional(),
    defaultWorkflow: z.string().default("issue_triage"),
    autoSelectModel: z.boolean().default(false).describe("Auto-pick model based on workflow complexity"),
    apiKey: z.string().optional().describe("API key (required when backend is 'api')"),
    apiModel: z.string().optional().describe("Model name for API backend (e.g. gpt-5.4-mini)"),
    apiBaseURL: z.string().optional().describe("API base URL (defaults to OpenCode Zen)"),
  }),
  tools: [
    "decide",
    "decideParallel",
    "classifyIssue",
    "reviewCode",
    "checkRelease",
  ],
} as const;

/**
 * Example usage for testing
 */
export async function demo(): Promise<void> {
  const modelPath = process.env.MODEL_PATH ?? "./models/qwen2.5-3b-instruct-q4_k_m.gguf";

  const agent = createSystemOneAgent({ modelPath });

  console.log("Available workflows:", agent.getWorkflows());
  console.log("Available parallel prompts:", agent.getParallelPrompts());

  // Test issue classification
  const result = await agent.classifyIssue(
    "Login fails with 500 error on Safari",
    "Users report login returns 500 only on Safari 17+. Works on Chrome/Firefox."
  );

  console.log("\nIssue classification:");
  console.log(JSON.stringify(result, null, 2));
}

// Run demo if executed directly
if (process.argv[1]?.endsWith("subagent.ts") || process.argv[1]?.endsWith("subagent.js")) {
  demo().catch(console.error);
}