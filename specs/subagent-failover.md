# Subagent Model Failover

Orchestrator (primary) keeps its best model. Subagents rotate a fallback chain
on retryable failure, resuming the *same* session so completed work is never lost.

## Chain order

```
agent.model → parent.model → small_model → last-recent-model (model.json) → OPENCODE_SUBAGENT_FALLBACKS (env)
```

The default subagent model is the last recently-used model from the parent session's
model picker (`model.json`), so subagents inherit whatever the invoking agent is
currently running — the same behavior Kilo Code uses. An explicit `agent.model`
or `small_model` override always wins; `OPENCODE_SUBAGENT_FALLBACKS` is the
last resort.

Cooled-down models (10 min) are skipped unless the whole chain is cooled.

**Retryable** (rotate to next model, same session): 429, rate/quota, usage limit,
overloaded, 5xx, timeout, network/connection, `doom_loop`/`no_edit_loop` break.

**Non-retryable** (fail fast with `task_id` so orchestrator can resume manually):
depth limit, unknown agent, permission denial, auth/forbidden.

## Resume behavior

On retry, the prompt is extended with a resume note referencing the prior
attempt's error and instructing the subagent to verify files on disk before
redoing work. The same `task_id` session is reused, so prior tool calls and
edits remain in context.

## Prototype

- `src/session/subagent-failover.ts` — chain builder, cooldown map, error
  classifier, resume prompt builder.
- `src/tool/task.ts` — retry loop around `ops.prompt`. Records metadata
  `subagentChain` on the task for visibility.

## Verification

- `bun test test/tool/task.test.ts` → 22 pass, 0 fail.
- `bun test test/provider/provider.test.ts` → 4 pre-existing fails (unrelated to
  this change; same on clean `git stash`).

## Usage

Set fallbacks via env, e.g.:

```
OPENCODE_SUBAGENT_FALLBACKS="kilo/nex-agi/nex-n2.5-mini:free,anthropic/claude-haiku-4-5"
```

Or configure `small_model` in `opencode.jsonc` — it becomes the first fallback.