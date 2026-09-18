/**
 * Core types for System One Lite
 * Schema-enforced structured decisions with calibrated confidence
 */

import { z } from "zod";

// --- Pools ---

export interface Candidate {
  value: string;
  start: number;
  end: number;
  source: string;
}

export interface Pools {
  text: string;
  spans: string[];
  numbers: Candidate[];
  dates: Candidate[];
  places: Candidate[];
  people: Candidate[];
  recentResults: string[];
  message: string;
}

// --- Preprocess ---

export interface PreprocessResult {
  text: string;
  fixes: Array<{ from: string; to: string }>;
  suggestions: Array<{ word: string; suggestions: string[] }>;
}

export interface PendingQuestion {
  key: string;
  type: "date" | "number" | "place" | "choice" | "candidate" | "noul";
  currentValue: string;
}

// --- Trace ---

export type ArgSource = "jev" | "code" | "user" | "default";

export interface ArgTrace {
  key: string;
  value: unknown;
  source: ArgSource;
  fromPool?: string;
}

export interface QuestionTrace {
  key: string;
  question: string;
  options: Record<string, string>;
  answer: unknown;
  probabilities?: Record<string, number>;
}

export interface ToolCallTrace {
  serverId: string;
  toolName: string;
  args: ArgTrace[];
  result: unknown;
}

export interface TurnTrace {
  id: string;
  originalMessage: string;
  preprocessedMessage: string;
  pools: Pools;
  jevCalls: QuestionTrace[][];
  chosenTool?: string;
  arguments?: ArgTrace[];
  toolCall?: ToolCallTrace;
  reply?: string;
  error?: string;
  latencyMs: number;
  confidence?: number;
}

// --- Tool Adapters ---

export interface ToolResult {
  content: unknown;
  isError?: boolean;
}

export interface ToolCard {
  title?: string;
  body?: string;
  fields?: Record<string, unknown>;
}

export interface QuestionDefinition {
  key: string;
  question: string;
  type: "choice" | "candidate" | "noul";
  options?: Record<string, string>;
  poolKey?: string;
}

export interface SingleStepAdapter {
  id: string;
  server: string;
  mcpName: string;
  label: string;
  description: string;
  examples: string[];
  questions: (pools: Pools) => Record<string, QuestionDefinition>;
  build: (
    answers: Record<string, any>,
    pools: Pools
  ) => { args: Record<string, any>; traces: ArgTrace[] } | { missing: string; question: string };
  present: (result: ToolResult) => { text: string; card: ToolCard };
}

export interface MultiStepAdapter extends SingleStepAdapter {
  run: (
    pools: Pools,
    askJev: (questions: QuestionDefinition[]) => Promise<Record<string, any>>
  ) => Promise<ToolResult>;
}

// --- Existing types ---

/**
 * Result of a structured decision
 */
export interface DecisionResult<T = unknown> {
  /** The validated structured output */
  value: T;
  /** Raw logits from model (if available) */
  logits?: number[];
  /** Calibrated confidence score 0-1 */
  confidence?: number;
  /** Latency in milliseconds */
  latencyMs: number;
  /** Tokens used */
  tokensUsed?: number;
}

/**
 * A single question in a parallel prompt
 */
export interface Question {
  /** Output field name */
  key: string;
  /** The question text */
  question: string;
  /** Zod schema for the answer */
  schema: z.ZodSchema;
  /** Optional context/description */
  description?: string;
}

/**
 * Parallel prompt with multiple questions answered in one call
 */
export interface ParallelPrompt {
  /** Shared context/state */
  context: string;
  /** Questions to answer */
  questions: Question[];
  /** Custom instruction */
  instruction?: string;
}

/**
 * Workflow step definition
 */
export interface WorkflowStep {
  /** Step name */
  name: string;
  /** Prompt template with {context} and {stepResults} placeholders */
  promptTemplate: string;
  /** Output schema */
  schema: z.ZodSchema;
  /** Extract decision from step output */
  extract?: (output: unknown) => unknown;
}

/**
 * Complete workflow (compute graph) of structured decisions
 */
export interface Workflow {
  /** Workflow name */
  name: string;
  /** Description */
  description: string;
  /** Steps in execution order */
  steps: WorkflowStep[];
}

/**
 * Result of running a workflow
 */
export interface WorkflowResult {
  /** Workflow name */
  workflowName: string;
  /** Step results by name */
  stepResults: Record<string, unknown>;
  /** Total latency in milliseconds */
  totalLatencyMs: number;
  /** Total tokens used */
  totalTokens: number;
  /** Whether workflow completed successfully */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Evaluation metrics
 */
export interface EvalMetrics {
  workflowName: string;
  nSamples: number;
  successRate: number;
  avgLatencyMs: number;
  avgTokens: number;
  agreementRate?: number;
  calibrationError?: number;
}

/**
 * Generator configuration
 */
export interface GeneratorConfig {
  /** Path to GGUF model */
  modelPath: string;
  /** Backend: "llama.cpp" | "llama-server" | "cli" | "api" */
  backend?: "llama.cpp" | "llama-server" | "cli" | "api";
  /** Context size */
  ctxSize?: number;
  /** GPU layers to offload */
  ngl?: number;
  /** Temperature */
  temperature?: number;
  /** Max tokens to generate */
  maxTokens?: number;
  /** llama.cpp/llama-server path */
  binaryPath?: string;
  /** llama-server URL if using server backend */
  serverUrl?: string;
}

/**
 * Calibration method
 */
export type CalibrationMethod = "temperature" | "platt" | "isotonic";

/**
 * Calibration data point
 */
export interface CalibrationPoint {
  /** Model logits */
  logits: number[];
  /** True label (1 = correct, 0 = incorrect) */
  label: number;
  /** Model's raw confidence */
  confidence: number;
}

/**
 * Model specification for 6GB VRAM
 */
export interface ModelSpec {
  name: string;
  hfRepo: string;
  filename: string;
  sizeGb: number;
  vramGb: number;
  qualityTier: 1 | 2 | 3;
  tags: string[];
}
