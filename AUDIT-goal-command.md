# Audit — `/goal` slash command (opencode)

Date: 2026-09-25 · Branch: `dev` @ `5e82437f5` · Scope: command wiring, plugin runtime, state machine, TUI/UI, test coverage

## Verdict

**Not solid — and not committed.** Before any code-level finding: the entire `/goal` command exists only as uncommitted working-tree changes. `git ls-files` confirms `src/command/template/goal.txt`, `packages/core/src/plugin/command/goal.txt`, and the whole `packages/opencode/test/goal/` suite are **untracked**, and `HEAD` has no `GOAL` entry in `Command.Default` at all. A fresh clone of `dev` has no `/goal` command. The audit below covers the working tree as it stands.

On the code itself: the command is correctly registered and reachable, all 9 goal tools are exposed, both typechecks are clean, and the 46 goal tests pass. But three defects break invariants the code itself asserts, and the single most damaging property is that **every failure mode presents to the user as "goal still active, silently doing nothing"** rather than as an error. None of the three are covered by tests.

## Baseline (verified, this tree)

| Check | Result |
|---|---|
| `packages/opencode` typecheck | clean |
| `packages/tui` typecheck | clean |
| `bun test test/goal/` | 17 pass / 0 fail (2 files) |
| `bun test test/prompt/goal-bar.test.tsx` (tui) | 29 pass / 0 fail |

## Wiring: correct

- `src/command/index.ts:48,72-80` registers `goal`; template `src/command/template/goal.txt`.
- `src/plugin/index.ts:25,86` → `goalPlugin.server` in `internalPlugins()` → `ToolRegistry` → `SessionTools.resolve` → the model.
- All 9 tools registered: `get_goal`, `get_goal_history`, `create_goal`, `set_goal`, `update_goal_objective`, `update_goal`, `update_goal_status`, `extend_goal`, `clear_goal` (`server.ts:827-969`).
- All 10 hooks are valid `Hooks` names with correct signatures. `dispose()` **is** called (`plugin/index.ts:272`), and finalizer ordering is correct.
- `goal.txt` has **no dead instructions** — every tool it names exists and is exposed.
- `goal-bar.tsx` **is** mounted (`packages/tui/src/component/prompt/index.tsx:61,1391`), not dead code.

---

## CRITICAL

### C1. `extend_goal` can wedge a limited goal permanently — two different "no turn limit" defaults

`impl.ts:441` (extension eligibility) vs `impl.ts:670` (runtime enforcement) + `server.ts:65`:

```ts
// impl.ts:441 — extension gate
const effectiveMaxAutoTurns = goal.maxAutoTurns ?? GOAL_DEFAULT_MAX_AUTO_TURNS   // schema.ts:13 -> 25

// impl.ts:670 — runtime enforcement
const effectiveMaxAutoTurns = goal.maxAutoTurns ?? defaultMaxAutoTurns            // server.ts:663 -> 0 = UNBOUNDED
```

**Confirmed by reproduction.** A goal created with `max_auto_turns: null` (documented as "unlimited"), driven to 30 auto-turns, then budget-limited:

```
BEFORE final extend: {"status":"budgetLimited","autoTurns":30,"maxAutoTurns":null}
AFTER extend:        {"status":"budgetLimited",
                      "lastStatus":"Goal limits extended, but cumulative usage still exceeds a limit."}
```

The user extends the token budget to 100M. It is applied, history records "extended", and the goal **stays `budgetLimited` forever** because `30 < 25` is false. `setGoalStatus` (`impl.ts:386`) and `updateGoalObjective` (`impl.ts:326`) both reject limited goals, so the only documented escape (`/goal extend`) is the thing that is broken. The runtime would never have turn-limited this goal at all.

Note the contract is three-way inconsistent: `HANDOFF-goal-migration.md:20` says null = "bounded default" (matches `impl.ts:441`); `server.ts:63-65` and the `create_goal` tool description say null = unlimited (matches `impl.ts:670`).

**Why tests miss it:** `lifecycle.test.ts:100` extends a goal with `autoTurns: 0`; `lifecycle.test.ts:164-179` re-declares the constant locally as `const UNBOUNDED = 0` instead of importing it.

**Fix:** resolve the default once and share it. Best: persist the effective turn limit onto the goal at creation (`impl.ts:289` already stores `maxAutoTurns`) rather than re-deriving at extension time.

### C2. `continuationFailures` is optional in schema but not normalized → `NaN` → silent breaker disablement → state file bricked

`schema.ts:172` makes it optional; `normalizeGoal` (`impl.ts:159-178`) defaults every other optional field but not this one. `impl.ts:632` does `goal.continuationFailures += 1`.

**Confirmed by reproduction**, from a state file merely *missing* the field:

```
getGoal.continuationFailures after partial read: undefined
failure ladder: [NaN, NaN, NaN]  status: active     <- 3-strike breaker never trips
raw on disk: null                                   <- JSON.stringify(NaN) === "null"
next read -> Error: StateReadError                  <- every session's goal unreadable
```

Two consequences: the `maxPromptFailures` circuit breaker is silently dead, and then the file is unreadable with no repair path — recovery means manually deleting `goals.json`. `HANDOFF-goal-migration.md:31` notes `InstanceState` is the codebase's per-directory mechanism; this bypasses it.

**Fix:** add `goal.continuationFailures = nonNegativeInteger(goal.continuationFailures, 0)` to `normalizeGoal`; make the schema field non-optional; and derive the `Goal`/`State` types from the schema instead of hand-maintaining them (`impl.ts:55-57` casts, which is why this drift type-checks).

### C3. A failed continuation POST is recorded as a *successful* continuation

`server.ts:334-342` — the `client.session.promptAsync(...)` result is never inspected, and the SDK does **not** throw on non-2xx unless `throwOnError` is passed (`packages/sdk/js/src/gen/client/client.gen.ts:168`); it returns `{ error, ... }` as a value. So `server.ts:798-804`:

```ts
await sendContinuation(...)
await recordContinuationResult(sessionID, "success", maxPromptFailures)   // runs unconditionally
```

On any 4xx/5xx from `POST /session/{id}/prompt_async` (e.g. session deleted between the idle event and the POST), the failure counter is reset and `awaitingContinuationProgress` is set — the circuit breaker can never trip for this mode. `/goal` reports `active`, `Auto-continues: N`, `Last status: Auto-continue prompt sent.` while **no turn is ever dispatched**. Goal mode is dead with no error and no pause.

`server.ts:737` (turn watchdog) is worse: no `recordContinuationResult` at all, so a failed watchdog continuation is entirely uncounted.

**Fix:** inspect the tuple and throw on `result.error` at both sites.

---

## HIGH

| # | Finding | Evidence |
|---|---|---|
| H1 | `closeGoal` is the only mutator with no `isClosed` guard, so a completed goal can be flipped to `unmet` and its evidence erased. **Reproduced:** `after complete: complete "all tests green"` → `after re-close: unmet evidence: null blocker: "actually not done"`. | `impl.ts:474-477` vs guards at `:325,385,423,356,621` |
| H2 | `recordContinuationResult` failure branch has no active-status check, so a `budgetLimited` goal becomes `paused` — bypassing the "must extend before resuming" invariant. | `impl.ts:632-643` |
| H3 | Any decode failure permanently disables goal state for **every** session; only `ENOENT` is recoverable, and the file is never quarantined or reset. | `impl.ts:67-83` |
| H4 | `recordContinuationResult` can transition limited→paused, defeating the extend-first guard the `/goal` prompt asserts. Compounded by the fact that H3 makes the failure path reachable. | `impl.ts:636-644` |
| H5 | A `session.children` error is indistinguishable from "no children": `server.ts:500-503` derives `[]` from an error tuple, then `markAbsentRunningChildren` force-clears **live** running-task state 250 ms later. Called on every `runAutoContinue`. | `server.ts:497-507`, `:605-610`, `:595-603` |
| H6 | `activeContinuations` can wedge forever — the claim is released only in `finally`, every await is untimed, and the SDK disables request timeouts globally (`packages/sdk/js/src/client.ts:33-44` sets `req.timeout = false`). | `server.ts:768-771,815-817` |
| H7 | Goal bookkeeping sits on the prompt critical path with no error isolation; a state-write failure **fails the user's entire prompt**. The `event` hook is dispatched fire-and-forget with no `.catch` (`plugin/index.ts:261`) → unhandled rejection. | `server.ts:983,992,997,1048`; `prompt.ts:1373` |
| H8 | The entire plugin `Options` surface is unreachable: `plugin/index.ts:174` calls `plugin(input)` with **no** second argument. All 13 options are dead, so `max_turn_time` never arms and the ~50-line turn watchdog never runs. Goal mode has **no user-facing configuration at all**. | `plugin/index.ts:173-176`; `server.ts:660-672,706` |
| H9 | Compaction under-charges then over-charges by the whole retained context: the transform hook receives only the compacted-away *prefix*, and `accountUsage` sets `lastSessionTokens` to that partial sum. | `session/compaction.ts:384-385`; `server.ts:992`; `impl.ts:520-537` |
| H10 | No test asserts the plugin is registered, or that the tool set matches the prompt. 0 of 9 tool handlers are executed by any test. Registration is one line (`plugin/index.ts:86`) — deleting it breaks nothing in CI. | `test/goal/*.test.ts` |

---

## MEDIUM (selected)

- **`set_goal` (`server.ts:857`) is a byte-for-byte duplicate of `create_goal`** and is named in **no** shipped prompt (`grep -c set_goal goal.txt` → 0). Unreferenced except by a repo-local skill. Either wire it or delete it.
- **`goal.txt` is duplicated and both copies are live** — `src/command/template/goal.txt` (via opencode's `Command`) and `packages/core/src/plugin/command/goal.txt` (via core's `CommandV2`). Identical today, nothing enforces it, and each package's tests only see its own copy.
- **No server/API surface for goal state at all.** `grep -rn goal packages/opencode/src/server/` → 0 matches. The TUI reads the private state file by path convention (`goal-bar.tsx:33-42` duplicating `impl.ts:36-45`). The desktop app **cannot** show goal state even in principle, and under `--port`/`--hostname` the TUI reads the *client's* local file, not the server's.
- **Every goal-bar "control" is an LLM turn, not a state mutation** (`goal-bar.tsx:289-301` → `session.command` → prompt template → model calls a tool). "Pause" costs a full model turn, can be refused, and fails silently.
- **Goal controls are mouse-only** — no `useBindings`/keymap anywhere in `goal-bar.tsx`. With `mouse: false` the bar renders an interactive row with a `▾` caret that does nothing. There is **no keyboard shortcut** for pause/resume/clear.
- **No i18n key for `goal`** in `en.ts` or any of the 66 app locales. The user-visible description is a hardcoded English server string (`command/index.ts:74`) rendered verbatim everywhere. No key drift, but no localization either.
- **Compaction summarizer gets the continuation prompt injected** into its system prompt (`server.ts:995-999` fires for every LLM request, including `agent: "compaction"`), degrading summary quality at the moment context is scarcest.
- **Goal state is one global, unbounded, unpruned file** rewritten in full several times per LLM step, serialized through a single process-wide `mutationQueue` — a disk-bound mutex on the step path that degrades as the file grows. Nothing prunes goals for deleted sessions.
- **`accountUsage` mutates closed goals** (`impl.ts:515-519`, no `isClosed` guard) — `tokensUsed` keeps climbing after completion, so a completed goal's cost audit is unreliable.
- **`updateGoalObjective` does not reset the no-progress/failure counters**, unlike `setGoalStatus` (`impl.ts:393-394`) — the two resume paths are not equivalent.
- **`lowOutput` requires `outputTokens > 0`**, so a zero-output turn is scored as *progress* and resets the no-progress counter (`impl.ts:571`).
- **`message.updated` has no role guard**, so user/compaction messages overwrite `lastAssistantMessageID` and corrupt the no-progress baseline.
- `goal-bar.tsx:20,66,240` models statuses `open`/`blocked`/`done` that the migrated schema can never produce; `goal-bar.test.tsx:173-181` asserts on a `"done"` the implementation never writes.

## Missing vs the unported `tui.ts`

The 427-line `tui.ts` was never ported. Evidence-based gap (fields the model maintains that **no UI reads anywhere**): token budget/used/remaining, `maxAutoTurns`/`autoTurns` (the number that predicts an imminent stop), duration usage, no-progress stall state, `continuationFailures`, checkpoints and 50-entry history (reachable **only** via the `get_goal_history` LLM tool), and `completionEvidence`/`blocker` — the bar simply vanishes on `complete`/`unmet`, so the user is never told how the goal ended. Plan-mode coupling also has no affordance: a goal created in Plan mode renders as a generic "Goal paused" with no hint that Build mode is the unblock.

**Net:** a user can see *that* a goal exists, *what* it is doing, and *roughly how long* it has run — and nothing else.

## Uncommitted work (this is the first thing to fix)

`git status` on branch `dev` @ `5e82437f5`:

```
 M packages/opencode/src/command/index.ts          <- adds Default.GOAL
 M packages/opencode/src/goal/{impl,schema}.ts     (+126 lines)
 M packages/opencode/src/plugin/goal/server.ts     (+126/-100)
 M packages/tui/src/component/prompt/goal-bar.tsx (+265 lines)
 M packages/tui/test/prompt/goal-bar.test.tsx
?? packages/opencode/src/command/template/goal.txt   <- the /goal prompt, UNTRACKED
?? packages/core/src/plugin/command/goal.txt          <- duplicate, UNTRACKED
?? packages/opencode/test/goal/                       <- both test files, UNTRACKED
```

Verified: `git show HEAD:packages/opencode/src/command/index.ts` has no `GOAL` key and imports only `initialize.txt`/`review.txt`. The feature does not exist on `dev` — this is a half-finished port whose command wiring and entire test suite have never been committed. `HANDOFF-goal-migration.md` claims the migration "is typecheck-clean" and was "committed as `58216b0b`", which does not match the tree.

## Minimum bar to call this solid

0. Commit the command template, the `Default.GOAL` registration, and the test suite. Right now the feature and its safety net exist only in a dirty worktree.
1. C1, C2, C3 fixed, each with a regression test that actually reproduces the failure.
2. H1 `isClosed` guard on `closeGoal` + test.
3. A registration test (plugin present, 9 tool keys) and a prompt↔tool drift test.
4. A fake-client test of the idle → auto-continue path, which currently has zero coverage of ~1000 of 1061 plugin lines.
5. Collapse the duplicated `goal.txt` and the re-implemented `UNBOUNDED` constant — both are what let the drift persist.
