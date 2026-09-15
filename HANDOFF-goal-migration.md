# Handoff — goal migration (packages/opencode/src/goal/)

## Status
Schema, impl, prompts, and plugin server are written and typecheck-clean in `packages/opencode`. The old plugin source and runtime state are committed as deleted. One open typecheck error remains in `packages/core`.

## What was done
Migrated the old committed plugin `@prevalentware/opencode-goal-plugin` (deleted from `.opencode/plugins/slash-goal/`) into a built-in module at `packages/opencode/src/goal/`.

- `packages/opencode/src/goal/schema.ts` — REWRITTEN, typecheck-clean. Exports `Goal`, `GoalSnapshot`, `GoalHistoryType`, `GoalHistoryEntry`, `GoalCheckpoint`, `State`, `GoalError`, `CreateGoalOptions`, `AssistantProgressInput`, `GOAL_*` constants.
- `packages/opencode/src/goal/impl.ts` — WRITTEN, ~685 lines, typecheck-clean. Full state machine ported from old `state.ts`.
- `packages/opencode/src/goal/prompts.ts` — WRITTEN, typecheck-clean. Exports `continuationPrompt`, `limitPrompt`, `planModeReminder`, `systemReminder`, `compactionContext`.
- `packages/opencode/src/goal/service.ts` — OLD STUB, `export * as GoalService from "./impl"`.
- `packages/opencode/src/plugin/goal/server.ts` — PORTED from old `server.ts` (998 lines), typecheck-clean. SDK return shapes fixed: `session.messages`/`children`/`status` now use `.data` access. Imports point to `@/goal/impl` and `@/goal/prompts`.
- `packages/opencode/src/plugin/goal/tui.ts` — NOT PORTED (old `tui.ts` was 427 lines of desktop TUI integration; deferred — the plugin works without it for now).
- Old plugin deleted: `.opencode/plugins/slash-goal/` (5 files, 4,283 lines) and `.opencode/goals/state.json.sessions/` (21 files). Committed as `58216b0b` on `dev`.
- Reference dump `.opencode/goal-ref/` (28 MB, 9 minified files) deleted — not tracked, no code references it.

## Remaining issues

### 1. `packages/core/src/config/plugin/agent.ts` line 104 — typecheck error
```
error TS2339: Property 'context' does not exist on type 'AgentV2Info'.
```
The `context` field was added to `packages/schema/src/agent.ts` `Agent.Info` (line 25) and to `packages/core/src/agent.ts` `AgentV2.Info` (re-export of schema). But inside the `draft.update(agentID, (agent) => { ... })` callback at line 104, TS resolves `agent` to `AgentV2Info` from `@opencode-ai/sdk/v2/types` (the generated SDK type, which does NOT have `context`), not to `Agent.Info` from the schema.

`AgentV2Info` is NOT directly imported in `core/src/config/plugin/agent.ts`. It may be leaking in via:
- A transitive type import through `State.Transformable<Draft>` / `State.create<Data, Draft>` — the `Draft.update` callback param type may be resolving to the SDK type instead of the schema type.
- A `/// <reference` directive somewhere in the core package.
- The `@opencode-ai/sdk` package being hoisted into `.opencode/node_modules` and its types being picked up by TS module resolution.

**Fix approach:** Check the actual resolved type of the `agent` parameter in the draft callback. Options:
- Cast `agent` to `Agent.Info` (schema) at the callback entry: `draft.update(agentID, (agent) => { ... })` → `draft.update(agentID, (agent: Agent.Info) => { ... })` — but this may conflict with the `Draft` type definition.
- Add `context` to the SDK-generated `AgentV2Info` type and regenerate the SDK.
- Investigate why `AgentV2.Info` in `core/src/agent.ts` resolves to the SDK type instead of the schema type at this call site.

### 2. Wire goal plugin into `internalPlugins()`
`packages/opencode/src/plugin/index.ts` line 67 — `internalPlugins()` returns the built-in plugin array. Add the goal plugin:
```ts
import { goalPlugin } from "./goal/server"
// ...
function internalPlugins(flags: RuntimeFlags.Info): PluginInstance[] {
  return [
    // ...existing plugins...
    goalPlugin,
  ]
}
```
Check the exact export name from `server.ts` — it exports `{ id: "local.goal-mode.server", server }` as default. The `internalPlugins` array expects `PluginInstance` functions. May need to export `server` directly or wrap it.

### 3. Remove plugin from `.opencode/opencode.jsonc`
The old `"plugin": ["@prevalentware/opencode-goal-plugin"]` line should already be removed (it was in the working tree). Verify it's gone.

### 4. Commit and push
The migration work (server.ts port, prompt.ts fix, plugin wiring) is not yet committed. The old plugin deletion is committed as `58216b0b` on `dev` (7 ahead of `origin/dev`).

## Key codebase facts
- Effect v4.0.0-beta.83. `Effect.gen(function* () {...})`, `Effect.tryPromise`, `Effect.try`, `Effect.fail(new GoalError(...))`.
- `Schema.decodeUnknownExit` not `Schema.decodeUnknown`. `Data.TaggedError` not `Schema.TaggedError`.
- `verbatimModuleSyntax: true` — type-only imports required.
- No `export namespace`. Flat top-level exports with `export * as X from "./y"` at bottom.
- `makeRuntime` from `src/effect/run-service.ts` for services; `InstanceState` for per-directory state.
- Plugin hooks: see `packages/plugin/src/index.ts` `Hooks` interface. `tool()` helper in `packages/plugin/src/tool.ts`.
- SDK client (`createOpencodeClient`) wraps responses in `{ data, error, request, response }`. Use `.data` to access the payload.
- Default branch is `dev`. Commit style: `type(scope): summary`.

## Verification
- `cd packages/opencode && bun run typecheck` — must show no `src/goal` or `src/plugin/goal` errors.
- `cd packages/core && bun run typecheck` — must show no `config/plugin/agent.ts` error.
- Goal plugin must appear in `internalPlugins()` output.
