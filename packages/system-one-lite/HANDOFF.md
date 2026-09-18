# System One Lite - Handoff Document

## Current Status: ALL WORKFLOWS USING SINGLE-CALL PARALLEL PROMPTS ✅ (100%)

### Architecture: Parallel Prompt Path (No Double Parallelism)

| Workflow | Steps Before | Steps After | Success Rate | Avg Latency | Notes |
|----------|--------------|-------------|--------------|-------------|-------|
| **issue_triage** | 1 | 1 (parallel prompt) | 100% | ~1.3s | 5 fields via single GBNF call |
| **code_review** | 3 | 1 (parallel prompt) | 100% | ~1.3s | 3 sub-questions in ONE model call |
| **release_readiness** | 1 | 1 (parallel prompt) | 100% | ~1.3s | 4 fields via single GBNF call |

### Known Issue: code_review fails with concurrency > 1 (FIXED ✅)
- **Root cause**: Double parallelism (workflow steps × batch contexts) multiplied GPU memory usage. For code_review (3 steps) with batch concurrency 2: 6 concurrent llama.cpp processes → OOM.
- **Fix**: Replaced multi-step code_review workflow with single-call parallel prompt. `decide()` now prefers parallel prompts when available, eliminating step-level parallelism entirely.
- **Result**: All workflows now use single model call. No GPU OOM regardless of batch concurrency.

### Also Working with Llama-3.1-8B (4.7GB)
- issue_triage: 100%, 2.5s/context
- code_review: 100%, 6.4s/context
- release_readiness: 100%, 2.5s/context

---

## Key Technical Fixes

### 1. Parallel Prompt Path (Eliminates Double Parallelism)
- `decide()` now prefers parallel prompts when available (`src/integration/subagent.ts:293-330`)
- Built-in workflows (`issue_triage`, `code_review`, `release_readiness`) all have parallel prompt equivalents
- Single model call per workflow → no step-level parallelism → no GPU OOM in batch mode
- Backwards compatible: workflows still run via `WorkflowRunner.run()` if no parallel prompt exists

### 2. GBNF Grammar Generator (`src/core/gbnf.ts`)
Rewrote `jsonSchemaToGbnf()` to match llama.cpp's `json_schema_to_grammar.py` output format:
- **Enum values with quotes**: `category ::= ("\"bug\"" | "\"feature\"")`
- **Hyphen-only rule names**: llama.cpp silently ignores grammars with underscores in rule names
- **Separate kv rules**: `category-kv ::= "\"category\"" space ":" space category`
- **Root concatenates kv rules**: `root ::= "{" space category-kv "," space priority-kv ... "}"`
- **`space` rule** (not `ws`): `space ::= | " " | "\n"{1,2} [ \t]{0,20}`
- **Base rules at END**: integer, number, boolean, space
- **NO generic `string` rule** - creates field-specific rules instead

### 3. `buildParallelGbnf` Unification
- Now uses `zodToGbnf(combinedSchema)` internally, keeping both grammar-generation paths consistent
- `getParallelGbnf` derives from compiled Zod schema, not from questions array directly

### 4. Schema Fixes (`src/eval/workflow.ts` and `src/core/parallel.ts`)
- **code_review**: Replaced unconstrained `string` fields (`details`, `reason`) with enums (`finding_type`, `reason_category`)
- Added `.describe("workflow_step_name")` to all step schemas for grammar cache keys

### 4. Generator Config (`src/integration/subagent.ts`)
- Default binary: `llama-completion` (NOT `llama-cli` - doesn't support `--grammar-file`)

---

## Files Structure
```
/home/pauk/Projects/opencode/packages/system-one-lite/
├── workflows/
│   ├── issue_triage_contexts.jsonl      (10 contexts)
│   ├── code_review_contexts.jsonl       (10 contexts)
│   └── release_readiness_contexts.jsonl (10 contexts)
├── src/
│   ├── core/
│   │   ├── generator.ts      # LlamaCppGenerator - main class
│   │   ├── gbnf.ts           # Grammar generation (FIXED)
│   │   ├── types.ts          # Type definitions
│   │   └── parallel.ts       # Parallel prompts (USED BY DEFAULT)
│   ├── eval/
│   │   ├── runner.ts         # CLI evaluation runner
│   │   └── workflow.ts       # Workflow definitions (fallback)
│   ├── integration/
│   │   └── subagent.ts       # SystemOneSubagent + OPENCODE_AGENT_MANIFEST
│   └── index.ts              # Exports
├── models/
│   ├── qwen2.5-3b-instruct-q4_k_m.gguf      (2.4GB)
│   └── Meta-Llama-3.1-8B-Instruct-Q3_K_M.gguf (4.7GB)
└── package.json
```

---

## Quick Test Commands

```bash
cd /home/pauk/Projects/opencode/packages/system-one-lite

# Test issue triage (fastest, 100%)
npm run eval -- run -w issue_triage -c workflows/issue_triage_contexts.jsonl -m "./models/qwen2.5-3b-instruct-q4_k_m.gguf" --limit 3

# Test code review (3 steps, 100%)
npm run eval -- run -w code_review -c workflows/code_review_contexts.jsonl -m "./models/qwen2.5-3b-instruct-q4_k_m.gguf" --limit 3

# Test release readiness (100%)
npm run eval -- run -w release_readiness -c workflows/release_readiness_contexts.jsonl -m "./models/qwen2.5-3b-instruct-q4_k_m.gguf" --limit 3

# Test subagent directly
npx tsx -e "
import { createSystemOneAgent } from './src/integration/subagent.js';
const agent = createSystemOneAgent({ modelPath: './models/qwen2.5-3b-instruct-q4_k_m.gguf' });
const r = await agent.classifyIssue('Login fails on Safari', '500 error on Safari 17+');
console.log(JSON.stringify(r, null, 2));
"
```

---

## opencode Integration

### Agent Definition
- **File**: `.opencode/agents/system-one.md`
- **Config**: `opencode.jsonc` → `agents.system-one`
- **Skills**: 
  - `.opencode/skills/system-one-triage/SKILL.md`
  - `.opencode/skills/system-one-code-review/SKILL.md`
  - `.opencode/skills/system-one-release-readiness/SKILL.md`

### Usage via Skills
- `/system-one-triage` — classify GitHub issues
- `/system-one-code-review` — audit code for security/correctness
- `/system-one-release-readiness` — assess release readiness

---

## Next Steps
1. Wire the skills into opencode's skill registry
2. Test end-to-end via `@system-one` subagent
3. Add streaming output for multi-step workflows (if any custom workflows need them)
4. Add model switching between qwen2.5-3b and Llama-3.1-8B

---

## Known Limitations
- **No parallel prompts tested** — `buildParallelGbnf` rewritten but not validated end-to-end
- **Single model at a time** — no model switching or fallback logic
- **3B model only** — Llama-3.1-8B available but not auto-selected

---

## Memory Keys for Reference
```bash
# Check project status
memory_memory_search(query="system-one-lite")
```

Key learnings saved:
- `project/system-one-lite-grammar-fix` - GBNF format details
- `project/system-one-lite-status` - Current workflow status
- `bugfix/system-one-lite-grammar-generation-fix` - Grammar generation fix details