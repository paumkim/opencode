# System One Lite

**Local structured decision layer for opencode** — schema-enforced outputs, parallel prompts, and calibrated confidence using local LLMs or API backends. No parse errors, no API lock-in.

## What it is

System One Lite is a TypeScript library that wraps LLM inference with Zod-validated schemas so you get structured JSON output every time. It supports three backends (local llama.cpp, OpenCode Zen API, or the opencode CLI), runs multi-question prompts in a single model call via combined GBNF grammars, and integrates directly into opencode as the `@system-one` subagent. Built for workflows like issue triage, code review, and release readiness where you need typed decisions, not free-form text.

## Installation

```bash
npm install @opencode/system-one-lite
```

Requires Node.js >= 20.0.0.

## Quick start

### Local llama.cpp backend

Requires `llama-completion` (or compatible llama.cpp binary) and a GGUF model.

```typescript
import { createSystemOneAgent } from "@opencode/system-one-lite";

const agent = createSystemOneAgent({
  modelPath: "./models/qwen2.5-3b-instruct-q4_k_m.gguf",
  ctxSize: 4096,
  ngl: 999, // offload all layers to GPU
});

const result = await agent.classifyIssue(
  "Login fails on Safari",
  "Users get 500 error only on Safari 17+"
);
console.log(result.stepResults);
// { category: "bug", priority: "P1", area: "frontend", estimated_hours: 4, needs_design_review: false }
```

### API backend (OpenCode Zen)

No local GPU needed. Uses a frontier model via OpenCode Zen for structured decisions.

```typescript
import { createSystemOneZenAgent } from "@opencode/system-one-lite";

const agent = await createSystemOneZenAgent("gpt-5.4-mini", {
  apiKey: process.env.OPENCODE_ZEN_API_KEY,
});

const result = await agent.classifyIssue(
  "Login fails on Safari",
  "Users get 500 error only on Safari 17+"
);
```

You can also use the generic factory with explicit config:

```typescript
import { createSystemOneAgent } from "@opencode/system-one-lite";

const agent = createSystemOneAgent({
  backend: "api",
  apiKey: process.env.OPENCODE_ZEN_API_KEY,
  apiModel: "gpt-5.4-mini",
  apiBaseURL: "https://opencode.ai/zen/v1",
});
```

### CLI backend

Reuses the opencode CLI's auth. No API key management needed.

```typescript
import { createSystemOneCliAgent } from "@opencode/system-one-lite";

const agent = createSystemOneCliAgent("opencode/muse-spark-1.3-contributor-free");

const result = await agent.classifyIssue(
  "Login fails on Safari",
  "Users get 500 error only on Safari 17+"
);
```

## Usage examples

### Classify an issue

```typescript
const result = await agent.classifyIssue(
  "Login fails on Safari",
  "Users report 500 error on Safari 17+. Works on Chrome/Firefox."
);
```

Returns a `WorkflowResult` with `stepResults` containing `category`, `priority`, `area`, `estimated_hours`, and `needs_design_review`.

### Review code

```typescript
const result = await agent.reviewCode(diff);
console.log(result.stepResults);
// { security: { has_vuln: false, severity: "none", finding_type: "none" }, ... }
```

### Check release readiness

```typescript
const result = await agent.checkRelease(
  "v2.4.0",
  "Bug fixes and performance improvements",
  "All 142 tests pass"
);
console.log(result.stepResults);
// { tests_pass: true, breaking_changes: false, migration_needed: false, confidence: 0.9 }
```

### Run a custom parallel prompt

```typescript
import { createParallelPrompt, buildParallelPromptText, buildParallelSchema, parseParallelOutput } from "@opencode/system-one-lite";
import { z } from "zod";

const supportPrompt = createParallelPrompt(
  "You are analyzing a support ticket.",
  [
    { key: "sentiment", question: "Is this positive or negative?", schema: z.enum(["positive", "negative", "neutral"]) },
    { key: "urgency", question: "How urgent is this?", schema: z.enum(["low", "medium", "high", "critical"]) },
    { key: "summary", question: "One-sentence summary?", schema: z.string().max(200) },
  ]
);

const agent = createSystemOneAgent({ modelPath: "./models/qwen2.5-3b-instruct-q4_k_m.gguf" });
agent.registerParallelPrompt("support", supportPrompt);

const result = await agent.decideParallel("support", "Customer cannot reset their password and is locked out of the account.");
// result: { sentiment: "negative", urgency: "high", summary: "..." }
```

### Run a workflow

```typescript
import { ISSUE_TRIAGE_WORKFLOW } from "@opencode/system-one-lite";

const result = await agent.decide("issue_triage", {
  context: "You are triaging a GitHub issue for a TypeScript project.\n\nIssue: Login fails on Safari\nUsers report 500 error only on Safari 17+.",
});
```

`decide()` automatically prefers the single-call parallel prompt path when one is registered for the workflow name, avoiding double parallelism (step-level × batch-level) that can exhaust GPU memory.

## Configuration

`SystemOneConfig` controls the subagent:

```typescript
interface SystemOneConfig {
  modelPath?: string;          // Path to GGUF model (local backends)
  backend?: "llama.cpp" | "llama-server" | "api" | "cli"; // default: "llama.cpp"
  ctxSize?: number;            // Context window size (default: 4096)
  ngl?: number;                // GPU layers to offload (default: 999 = all)
  temperature?: number;        // Sampling temperature (default: 0.0)
  maxTokens?: number;          // Max tokens to generate (default: 512)
  binaryPath?: string;         // llama.cpp binary (default: "llama-completion")
  serverUrl?: string;          // llama-server URL for server backend
  defaultWorkflow?: string;    // Workflow name for auto model selection
  autoSelectModel?: boolean;   // Auto-pick model based on workflow complexity
  apiKey?: string;             // API key for API backend
  apiModel?: string;           // Model name for API backend (default: "gpt-5.4-mini")
  apiBaseURL?: string;         // API base URL (default: "https://opencode.ai/zen/v1")
  cliModel?: string;           // Model name for CLI backend
  models?: ModelCapabilities[]; // Custom model registry for auto-selection
}
```

**Environment variables**: The API generator resolves `env:VAR_NAME` strings in `apiKey`, `apiModel`, and `apiBaseURL`. It loads `.env.local` and `.env` from the package root and `process.cwd()`.

**Confidence gating**: The `confidenceGate()` helper wraps values with confidence metadata when confidence is below 0.7, returning `{ options, probabilities }` instead of a single value. `executeTurn()` uses this to surface uncertainty to the caller.

## Models

### Recommended models

| Model | Cost | Context | Notes |
|-------|------|---------|-------|
| `kilo-auto/free` | **free** | 204K | No credits needed. Basic intelligence, may need relaxed enums. |
| `kilo-auto/small` | $0.05/$0.40 per MTok | 400K | Cheap paid tier. Better schema compliance. |
| `kilo-auto/balanced` | $0.60/$3.00 per MTok | 204K | Mid-tier paid. |
| `kilo-auto/frontier` | $5.00/$25.00 per MTok | 1M | Highest quality, highest cost. |

**Note:** Only `kilo-auto/free` requires no credits. All others need a funded Kilo account.

### Downloading models

```typescript
import { downloadModel, autoSelectModel, getModelInfo } from "@opencode/system-one-lite";

// Download a specific model
await downloadModel("qwen2.5-3b-instruct-q4_k_m", "./models");

// Auto-select best model for a workflow
const model = autoSelectModel("code_review"); // picks high-accuracy model for complex workflow

// Inspect a local GGUF
const info = await getModelInfo("./models/qwen2.5-3b-instruct-q4_k_m.gguf");
```

### Auto model selection

Enable `autoSelectModel: true` with a `defaultWorkflow` to automatically pick a model based on workflow complexity (number of steps, open-ended fields, object shapes).

```typescript
const agent = createSystemOneAgent({
  backend: "llama.cpp",
  autoSelectModel: true,
  defaultWorkflow: "code_review", // will pick a high-accuracy model
});
```

## opencode integration

Register System One Lite as the `@system-one` subagent in your opencode config:

```jsonc
// opencode.jsonc
{
  "agents": {
    "system-one": {
      "type": "subagent",
      "description": "Structured decisions with local models",
      "config": {
        "backend": "llama.cpp",
        "modelPath": "./models/qwen2.5-3b-instruct-q4_k_m.gguf",
        "ngl": 999,
        "ctxSize": 4096
      }
    }
  }
}
```

The exported `OPENCODE_AGENT_MANIFEST` defines the subagent contract:

```typescript
import { OPENCODE_AGENT_MANIFEST } from "@opencode/system-one-lite";

// {
//   name: "system-one",
//   description: "Structured decision making with local models (System One Lite)",
//   type: "subagent",
//   configSchema: z.object({ ... }),
//   tools: ["decide", "decideParallel", "classifyIssue", "reviewCode", "checkRelease"]
// }
```

## Skills

System One Lite exposes three built-in skill commands that wire into the `@system-one` subagent's tools:

- `/system-one-triage` — classify GitHub issues (`classifyIssue`)
- `/system-one-code-review` — audit code for security and correctness (`reviewCode`)
- `/system-one-release-readiness` — assess release readiness (`checkRelease`)

Each skill is a thin wrapper that constructs the appropriate context and calls the corresponding subagent tool. Define them under `.opencode/skills/` following the opencode skill format.

## Testing

```bash
# Run unit tests
npm test

# Run evaluation harness on a workflow
npm run eval -- run \
  -w issue_triage \
  -c workflows/issue_triage_contexts.jsonl \
  -m "./models/qwen2.5-3b-instruct-q4_k_m.gguf" \
  --limit 10 \
  --concurrency 2

# Compare two models
npm run eval -- run \
  -w code_review \
  -c workflows/code_review_contexts.jsonl \
  -m "./models/qwen2.5-3b-instruct-q4_k_m.gguf" \
  -r "./models/Meta-Llama-3.1-8B-Instruct-Q3_K_M.gguf" \
  --output results.jsonl
```

The eval runner outputs success rate, average latency, average tokens, and agreement rate (when a reference model is provided).

## Architecture

### Parallel prompt vs workflow paths

System One Lite has two execution paths, and `decide()` intelligently chooses between them:

1. **Parallel prompt (preferred)** — All questions for a workflow are answered in a single model call. The Zod schemas for all questions are combined into one GBNF grammar, so the model generates one JSON object containing every field. This avoids step-level parallelism and prevents GPU memory exhaustion during batch evaluation. Built-in workflows (`issue_triage`, `code_review`, `release_readiness`) all have parallel prompt equivalents.

2. **Workflow (fallback)** — Multi-step execution with dependency-aware parallelism. Steps whose dependencies are already resolved run in parallel via `Promise.all`; dependent steps wait. This path is used when no parallel prompt is registered for a workflow name, or for custom workflows that need sequential reasoning across steps.

```
Parallel prompt path:
  Prompt + combined GBNF → llama.cpp → JSON → Zod.parse → stepResults

Workflow path:
  Step A ──┐
           ├→ Prompt A + GBNF → llama.cpp → result A
  Step B ──┘         │
                     ├→ Prompt C (uses A+B) + GBNF → llama.cpp → result C
  Step D ────────────┘
```

### Backends

- **llama.cpp** — Spawns `llama-completion` with `--grammar-file` for GBNF-constrained generation. Zero parse errors by construction.
- **API** — Sends JSON Schema to OpenCode Zen (OpenAI-compatible `/responses` or Anthropic `/messages` endpoint depending on model family). Schema validation happens client-side.
- **CLI** — Shells out to `opencode run` with the same auth store the CLI uses. Structured output is extracted via JSON Schema instructions in the prompt.

### Calibration

Confidence scores are estimated heuristically from schema complexity and output completeness. For production calibration, use the exported scalers:

```typescript
import { TemperatureScaler, expectedCalibrationError } from "@opencode/system-one-lite";

const scaler = new TemperatureScaler();
scaler.fit(validationLogits, validationLabels);
const calibrated = scaler.calibrate(testLogits);
const ece = expectedCalibrationError(confidences, accuracies);
```

## License

MIT
