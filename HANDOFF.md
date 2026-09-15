# Handoff — Agent Context Toggle (`context: "minimal" | "full"`)

## Goal

Allow a local model to be used for simple chatting through opencode **without loading any project context** (AGENTS.md, skills, MCP, environment info). The model's context window stays clear ("headroom clear") for actual conversation, separate from opencode's config/agents.md rules.

## What Was Done

Added a `context` field to agent configs that gates which system-prompt components get loaded.

### Files Changed (6)

| File | Change |
|------|--------|
| `packages/schema/src/agent.ts` | Added `context: Schema.Literals(["minimal", "full"]).pipe(optional)` to `Agent.Info` |
| `packages/core/src/v1/config/agent.ts` | Added `context` field to `AgentSchema` + `KNOWN_KEYS` |
| `packages/core/src/config/agent.ts` | Added `context` field to `ConfigAgent.Info` (v2) |
| `packages/core/src/config/plugin/agent.ts` | Added `context` to `agentKeys` set + mapping (`if (item.context !== undefined) agent.context = item.context`) |
| `packages/opencode/src/agent/agent.ts` | Added `context` to `Agent.Info` schema + pass-through from config (`item.context = value.context ?? item.context`) |
| `packages/opencode/src/session/prompt.ts` | **Core logic**: When `agent.context === "minimal"`, skips `sys.skills()`, `sys.environment()`, `sys.mcp()`, and `instruction.system()` (AGENTS.md/CLAUDE.md). System prompt becomes just agent prompt + provider prompt + user system prompt + message history. |

### How to Use

```jsonc
// opencode.jsonc
{
  "agent": {
    "chat": {
      "model": { "providerID": "ollama", "modelID": "llama3" },
      "context": "minimal",
      "prompt": "You are a helpful chat assistant. Keep responses brief."
    }
  }
}
```

Or in a markdown agent file (`.opencode/agents/chat.md`):

```markdown
---
model: ollama/llama3
context: minimal
prompt: |
  You are a helpful chat assistant. Keep responses brief.
---
```

## Remaining Issue

**`packages/core` typecheck fails** with:
```
src/config/plugin/agent.ts(104,53): error TS2339: Property 'context' does not exist on type 'AgentV2Info'.
```

The `AgentV2Info` type is from `@opencode-ai/sdk` (generated types), **not** from `@opencode-ai/schema/agent`. The plugin file imports `AgentV2` from `../../agent` (core's `agent.ts`), which re-exports from the schema. But TypeScript is resolving the `agent` parameter type in the draft update callback to `AgentV2Info` (SDK type) instead of `Agent.Info` (schema type).

### Possible Causes to Investigate

1. The `AgentV2` module in `core/src/agent.ts` may not be correctly re-exporting `Info` from the schema — check if there's a circular dependency or the re-export is being shadowed.
2. The `AgentV2Info` type from `@opencode-ai/sdk` may be leaking in via some type declaration file or `/// <reference>` directive.
3. The schema package may need a build step to generate `.d.ts` files that the core package picks up.
4. Check if `AgentV2.Info` in the draft callback is actually `AgentV2Info` (SDK) vs `Agent.Info` (schema) — the draft's `update` callback parameter type may be coming from a different source.

### Pre-existing Errors (not caused by this change)

- `packages/core`: `projector.ts` errors (pre-existing)
- `packages/opencode`: theme/ColorValue errors, goal/impl.ts errors (pre-existing)

## Verification

- `packages/schema` typecheck: **passes** ✅
- `packages/opencode` typecheck: pre-existing errors only, no new errors from my changes ✅
- `packages/core` typecheck: **1 new error** (the `AgentV2Info` issue above) ❌

## Next Steps

1. Fix the `AgentV2Info` type resolution issue in `packages/core/src/config/plugin/agent.ts`
2. Run `bun typecheck` from `packages/core` to confirm the fix
3. Optionally regenerate the SDK types if `AgentV2Info` needs `context` added there too