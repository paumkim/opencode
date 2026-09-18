# System One Lite - Handoff Document

## Current Status: ALL WORKFLOWS WORKING ✅ (100% on all 3)

### Working Workflows (qwen2.5-3b-instruct-q4_k_m, 2.4GB, 6GB VRAM)

| Workflow | Steps | Success Rate | Avg Latency | Notes |
|----------|-------|--------------|-------------|-------|
| **issue_triage** | 1 | 100% (3/3) | 1.4s | 5 fields: 3 enums, 1 int, 1 bool |
| **code_review** | 3 | 100% (3/3) | 3.0s | 3 steps × 3 fields each (all enums/bools) |
| **release_readiness** | 1 | 100% (3/3) | 1.4s | 4 fields: 3 bools, 1 number (0-1) |

### Also Working with Llama-3.1-8B (4.7GB)
- issue_triage: 100%, 2.5s/context
- code_review: 100%, 6.4s/context

---

## Key Technical Fixes

### 1. GBNF Grammar Generator (`src/core/gbnf.ts`)
Rewrote `jsonSchemaToGbnf()` to match llama.cpp's `json_schema_to_grammar.py` output format:
- **Enum values with quotes**: `category ::= ("\"bug\"" | "\"feature\"")`
- **Hyphen-only rule names**: llama.cpp silently ignores grammars with underscores in rule names
- **Separate kv rules**: `category-kv ::= "\"category\"" space ":" space category`
- **Root concatenates kv rules**: `root ::= "{" space category-kv "," space priority-kv ... "}"`
- **`space` rule** (not `ws`): `space ::= | " " | "\n"{1,2} [ \t]{0,20}`
- **Base rules at END**: integer, number, boolean, space
- **NO generic `string` rule** - creates field-specific rules instead

### 2. `buildParallelGbnf` Rewrite
Rewrote to use the proven path: combined Zod schema → `zodToJsonSchema` → `jsonSchemaToGbnf`.
The old function had 4 bugs:
- Checked `s.type` (undefined for Zod) instead of `s._def.typeName`
- Used `JSON.stringify` for visited set (identical strings for all ZodObject schemas)
- Used underscores in rule names (llama.cpp silently ignores)
- Constrained integer rules also used underscores

### 3. Schema Fixes (`src/eval/workflow.ts`)
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
│   │   └── parallel.ts       # Parallel prompts
│   ├── eval/
│   │   ├── runner.ts         # CLI evaluation runner
│   │   └── workflow.ts       # Workflow definitions (FIXED)
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
3. Add streaming output for multi-step workflows
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