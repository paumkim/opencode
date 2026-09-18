# System One Lite

**Local structured decision layer** — A "System One Lite" approximation using only local models (no API costs).

## Features

- **Schema-enforced outputs** — Zero parse errors via GBNF constrained generation
- **Parallel prompts** — Multiple questions answered in single model call
- **Calibrated confidence** — Temperature/Platt/Isotonic calibration (pure TypeScript)
- **Workflow evals** — TypeSafe-style evaluation harness
- **opencode integration** — `@system-one` subagent for structured decisions in workflows
- **6GB VRAM optimized** — Runs on consumer GPUs with quantized models

## Architecture

```
TypeScript (Bun/Node)          llama.cpp (C++)
┌─────────────────────┐        ┌─────────────────────┐
│ Zod schemas         │ ───►   │ GBNF grammar        │
│ Type-safe workflows │        │ Quantized GGUF      │
│ Calibration (TS)    │        │ GPU offload (-ngl)  │
│ opencode subagent   │        │ 70-500ms latency    │
└─────────────────────┘        └─────────────────────┘
```

## Quick Start

### 1. Install Dependencies

```bash
cd /home/pauk/Projects/opencode/packages/system-one-lite
bun install
```

### 2. Download a Model (6GB VRAM recommended)

```bash
# Best quality for 6GB: Qwen2.5 7B Q3_K_M (~4.1GB)
bun run src/models/loader.ts auto ./models 1

# Most comfortable: Qwen2.5 3B Q4_K_M (~2.4GB)
bun run src/models/loader.ts download qwen2.5-3b-instruct-q4_k_m ./models
```

### 3. Run Evaluation

```bash
# Issue triage workflow
bun run src/eval/runner.ts run \
  --workflow issue_triage \
  --contexts workflows/issue_triage_contexts.jsonl \
  --model ./models/qwen2.5-3b-instruct-q4_k_m.gguf \
  --output results.jsonl
```

### 4. Use as Library

```typescript
import { createSystemOneAgent, ISSUE_TRIAGE_WORKFLOW } from "@opencode/system-one-lite";

const agent = createSystemOneAgent({
  modelPath: "./models/qwen2.5-3b-instruct-q4_k_m.gguf",
  ctxSize: 4096,
  ngl: 999,
});

// Classify an issue
const result = await agent.classifyIssue(
  "Login fails on Safari",
  "Users get 500 error only on Safari 17+"
);
console.log(result);
// { category: "bug", priority: "P1", area: "frontend", estimated_hours: 4, needs_design_review: false }
```

## Available Workflows

| Workflow | Steps | Description |
|----------|-------|-------------|
| `issue_triage` | 1 | Classify GitHub issues (category, priority, area, estimate) |
| `code_review` | 3 | Security → Correctness → Final decision |
| `release_readiness` | 1 | Tests, breaking changes, migration, confidence |

## Parallel Prompts (Single Call)

```typescript
import { ISSUE_TRIAGE_PROMPT, buildParallelPromptText } from "@opencode/system-one-lite";

// 5 questions in ONE model call
const prompt = buildParallelPromptText(ISSUE_TRIAGE_PROMPT);
// Output: JSON with category, priority, area, estimated_hours, needs_design_review
```

## Calibration

```typescript
import { TemperatureScaler, expectedCalibrationError } from "@opencode/system-one-lite";

const scaler = new TemperatureScaler();
scaler.fit(validationLogits, validationLabels);

const calibratedProbs = scaler.calibrate(testLogits);
const ece = expectedCalibrationError(confidences, accuracies);
```

## opencode Integration

Register as `@system-one` subagent:

```json
{
  "name": "system-one",
  "type": "subagent",
  "config": {
    "modelPath": "./models/qwen2.5-3b-instruct-q4_k_m.gguf",
    "ngl": 999,
    "ctxSize": 4096
  }
}
```

Then use in workflows:

```yaml
# .opencode/workflow/issue-triage.yaml
steps:
  - agent: system-one
    tool: classifyIssue
    args:
      title: "{{issue.title}}"
      body: "{{issue.body}}"
```

## Model Recommendations for 6GB VRAM

| Model | Quant | VRAM | Quality | Best For |
|-------|-------|------|---------|----------|
| Qwen2.5 7B | Q3_K_M | 4.5GB | ⭐⭐⭐⭐⭐ | Complex reasoning |
| Qwen2.5 3B | Q4_K_M | 2.8GB | ⭐⭐⭐⭐ | Fast decisions |
| Phi-3.5-mini | Q4_K_M | 3.2GB | ⭐⭐⭐⭐ | Balanced |
| CodeQwen 1.5B | Q4_K_M | 1.7GB | ⭐⭐⭐ | Code tasks |

## Building Single Binary

```bash
bun build --compile --target=bun-linux-x64 ./src/index.ts --outfile system-one-lite
./system-one-lite --help
```

## Project Structure

```
system-one-lite/
├── src/
│   ├── core/
│   │   ├── types.ts          # Core type definitions
│   │   ├── generator.ts      # LlamaCppGenerator with GBNF
│   │   ├── gbnf.ts           # Zod → GBNF conversion
│   │   ├── parallel.ts       # Multi-question prompts
│   │   └── calibrator.ts     # Temperature/Platt/Isotonic
│   ├── eval/
│   │   ├── workflow.ts       # Workflow definitions & runner
│   │   └── runner.ts         # CLI for batch evaluation
│   ├── models/
│   │   └── loader.ts         # VRAM-aware model management
│   ├── integration/
│   │   └── subagent.ts       # @system-one opencode subagent
│   └── index.ts              # Main exports
├── workflows/
│   └── issue_triage_contexts.jsonl
├── DECISIONS.md              # Architecture decisions
├── package.json
├── tsconfig.json
└── bunfig.toml
```

## Why TypeScript?

See [DECISIONS.md](DECISIONS.md) for full rationale. Summary:

- Native opencode integration (same codebase)
- End-to-end type safety: Zod → TS types → GBNF → validated output
- Single binary deployment via `bun build --compile`
- No Python dependency hell
- Team familiarity

## License

MIT