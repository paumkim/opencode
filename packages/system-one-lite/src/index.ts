/**
 * System One Lite - Local Structured Decision Layer
 * 
 * A "System One Lite" approximation using only local models:
 * - Schema-enforced structured outputs (zero parse errors via GBNF)
 * - Parallel multi-question prompts (single call, multiple typed outputs)
 * - Calibrated confidence scores (temperature/Platt/isotonic)
 * - Workflow eval harness (TypeSafe-style evaluation)
 * - Native opencode integration via @system-one subagent
 */

// Core types
export * from "./core/types.js";

// Core generation
export { LlamaCppGenerator, createGenerator } from "./core/generator.js";
export { ApiGenerator, createZenGenerator, createZenGeneratorFromAuth, resolveEnv, zodToJsonSchema } from "./core/api-generator.js";
export { CliGenerator, createCliGenerator } from "./core/cli-generator.js";
export { zodToGbnf, buildParallelGbnf, writeGbnfFile, cleanupGbnfFile, GBNF } from "./core/gbnf.js";
export { createParallelPrompt, buildParallelPromptText, buildParallelSchema, parseParallelOutput, estimateParallelConfidence, ISSUE_TRIAGE_PROMPT, CODE_REVIEW_PROMPT, RELEASE_READINESS_PROMPT } from "./core/parallel.js";
export { TemperatureScaler, PlattScaler, IsotonicCalibrator, createCalibrator, expectedCalibrationError, saveCalibrator, loadCalibrator } from "./core/calibrator.js";

// Pools and pre-processing
export { buildPools, type Pools, type Candidate } from "./core/pools.js";
export { correctSpelling, resolveFollowUp, type PreprocessResult, type PendingQuestion } from "./core/preprocess.js";

// Trace
export { generateTraceId, type TurnTrace, type QuestionTrace, type ArgTrace, type ToolCallTrace, type ArgSource } from "./core/trace.js";

// Tools
export { toolRegistry, type SingleStepAdapter, type MultiStepAdapter, type QuestionDefinition, type ToolResult, type ToolCard } from "./tools/index.js";
export { rawFallback } from "./tools/kit/adapter.js";
export { Args, type MissingArg } from "./tools/kit/args.js";
export { McpClient, type ToolDefinition, type McpTransport } from "./tools/mcp-client.js";

// Evaluation
export { WorkflowRunner, computeMetrics, computeAgreement, loadContexts, saveResults, ISSUE_TRIAGE_WORKFLOW, CODE_REVIEW_WORKFLOW, RELEASE_READINESS_WORKFLOW } from "./eval/workflow.js";

// Models
export { RECOMMENDED_MODELS, getGpuVram, recommendModels, downloadModel, listLocalModels, getModelInfo, autoSelectModel, modelCli } from "./models/loader.js";

// Integration
export { SystemOneSubagent, createSystemOneAgent, createSystemOneAgentFromModel, createSystemOneZenAgent, createSystemOneCliAgent, OPENCODE_AGENT_MANIFEST, type PendingAction } from "./integration/subagent.js";

// Version
export const VERSION = "0.1.0";