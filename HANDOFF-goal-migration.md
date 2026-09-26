# Handoff — goal migration (packages/opencode/src/goal/)

## Status
Schema, impl, prompts, plugin server, lifecycle tests, and TUI integration are typecheck-clean in their focused packages. The goal plugin is wired through `internalPlugins()`. The old plugin source and runtime state were migrated out of the built-in goal path.

## What was done
Migrated the old committed plugin `@prevalentware/opencode-goal-plugin` (deleted from `.opencode/plugins/slash-goal/`) into a built-in module at `packages/opencode/src/goal/`.

- `packages/opencode/src/goal/schema.ts` — REWRITTEN, typecheck-clean. Exports `Goal`, `GoalSnapshot`, `GoalHistoryType`, `GoalHistoryEntry`, `GoalCheckpoint`, `State`, `GoalError`, `CreateGoalOptions`, `AssistantProgressInput`, `GOAL_*` constants.
- `packages/opencode/src/goal/impl.ts` — WRITTEN and typecheck-clean. Full state machine ported from old `state.ts`, with serialized limited-goal extension and closed-goal lifecycle guards.
- `packages/opencode/src/goal/prompts.ts` — WRITTEN, typecheck-clean. Exports `continuationPrompt`, `limitPrompt`, `planModeReminder`, `systemReminder`, `compactionContext`.
- `packages/opencode/src/goal/service.ts` — OLD STUB, `export * as GoalService from "./impl"`.
- `packages/opencode/src/plugin/goal/server.ts` — PORTED from old `server.ts` (998 lines), typecheck-clean. SDK return shapes fixed: `session.messages`/`children`/`status` now use `.data` access. Imports point to `@/goal/impl` and `@/goal/prompts`.
- `packages/opencode/src/plugin/goal/tui.ts` — NOT PORTED (old `tui.ts` was 427 lines of desktop TUI integration; deferred — the plugin works without it for now).
- Old plugin deleted: `.opencode/plugins/slash-goal/` (5 files, 4,283 lines) and `.opencode/goals/state.json.sessions/` (21 files). Committed as `58216b0b` on `dev`.
- Reference dump `.opencode/goal-ref/` (28 MB, 9 minified files) deleted — not tracked, no code references it.

## Operational defaults and long-running workaround

Normal goals remain bounded: when no per-goal value is supplied, the plugin uses its configured defaults, including a 25 auto-continue limit. A goal that exhausts a token, turn, or duration limit is not resumed by the ordinary pause/resume operation. Use `/goal extend ...` (or the `extend_goal` tool) with an explicitly higher positive limit, or deliberately set `token_budget=null` / `max_duration_seconds=null` to remove those limits. `max_auto_turns=null` restores the bounded default; it does not mean unlimited turns. Extension preserves cumulative usage, time, checkpoints, history, and evidence, and reactivates only when the new limits actually admit the recorded usage. Keep the normal bounded default unless the user explicitly requests long-running mode.

## Remaining issues

The goal lifecycle and TUI packages have focused typechecks passing. A previously documented unrelated `packages/core` agent-context type issue is outside this migration and was not changed here.

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
- `cd packages/opencode && bun test test/goal/lifecycle.test.ts` — focused lifecycle regressions.
- `cd packages/tui && bun test test/prompt/goal-bar.test.tsx` — limited label, prompt submission, and cancel behavior.
- `cd packages/opencode && bun run typecheck` — goal implementation and plugin server.
- `cd packages/tui && bun run typecheck` — TUI goal bar integration.
