---
name: autonomous-dev
description: |
  Use when the user explicitly requests autonomous-dev for a concrete objective,
  or explicitly asks it to formulate and pursue a goal. Starts or reuses a real
  session goal for runtime-managed continuation, with bounded tasks, checkpoints,
  recovery, and evidence-based completion. Loading alone does not authorize activation.
---

# Autonomous Dev — Scoped Goal Execution

## Authorization boundary

This is an opt-in workflow, not the default for all tasks. Work only toward the
user-authorized objective, within higher-priority instructions and tool contracts.
An explicit request such as “Use autonomous-dev to fix X and verify Y” authorizes
the startup sequence below; do not merely promise to work autonomously.

Reading, editing, reviewing, or incidentally auto-loading this skill is NOT
permission to create a goal. A subagent loading it is NOT authorization either.
If asked only to inspect or test the skill, do not activate a real goal as a test.
Never infer consent from the presence of this document in context.

## Mandatory startup: real goal, then verify

On an explicit user request to activate/use autonomous-dev on an objective,
immediately perform the following before implementation or delegation:

1. Call `get_goal()` to inspect the current session's goal.
2. If there is no goal, call `create_goal({objective: "..."})` with the concrete
   authorized deliverable, scope, and acceptance checks. If the user explicitly
   asks the agent to formulate and set its own goal, formulate that objective
   within the requested scope and use `set_goal({objective: "..."})` instead.
   If the objective is too ambiguous to authorize concrete work, ask for scope.
3. Call `get_goal()` again after creation and verify the returned objective and
   status. Proceed with implementation only if it is `active` and execution is
   allowed. Report the observed state rather than assuming creation succeeded.

Handle existing state instead of blindly calling a creation tool:

| Observed state | Required action |
| --- | --- |
| Active, same objective | Reuse it; inspect history/checkpoints and continue scoped work. |
| Paused | Do not resume from activation alone. Require an explicit resume request; use `update_goal_status({status: "active"})` only when allowed, then `get_goal()`. |
| Different unresolved goal | Report the conflict. Never overwrite, clear, or close it to make room without the required authorization/evidence. |
| Completed or otherwise closed | Do not restart old work. For an explicitly requested new objective, follow the exposed creation tool's eligibility rules and verify the result. |
| Budget/usage limited | Preserve the limit and checkpoint; do not recreate or resume to evade it. |

In Plan mode, creation records a **paused** goal. Ask the user to switch to Build
and explicitly resume; do not switch modes automatically or begin implementation.
Editing an objective requires an explicit edit/replace request and the exposed
`update_goal_objective` tool. Pausing/resuming uses `update_goal_status` only on
an explicit request. Clearing uses `clear_goal` only when explicitly authorized.
Re-read state after lifecycle changes; tool errors are not successful transitions.

## Runtime contract and limitations

The goal tools operate on the real session goal used by `/goal` when that command
is registered. Invoke tools directly; never try to execute an imaginary slash
command through Bash. Tool names and arguments must match the exposed runtime.

If goal tools are unavailable, disclose: “I cannot enable real goal auto-turns in
this session.” Work directly only within the remaining authorization; do not
present a todo list or message-bus record as a real goal. Do not install a plugin,
modify global legacy plugins/config, or add a second continuation mechanism.

The runtime schedules continuation, not this skill. In the inspected checkout,
the goal plugin handles idle events, continuation eligibility, task deferral,
limits, and failures. An active goal alone does not prove automatic turns will
arrive: plugin options, deployment, permissions, mode, and failures can differ.
Verify state/history with `get_goal()` / `get_goal_history()` and report observed
continuation separately from expectations. Editing this file is not implementing
or deploying runtime integration, nor proving the running process uses this checkout.

Pass explicit user limits through supported creation fields: `token_budget`,
`max_auto_turns`, and `max_duration_seconds`. Otherwise preserve runtime defaults;
do not invent unlimited settings or reset a goal to bypass enforcement. There is
no `auto_continue` creation argument in the inspected tool schema.
Honor user stop/pause requests, runtime budgets and duration limits, permissions,
and required approvals for external side effects. Autonomous execution does not
authorize commits, pushes, deployments, purchases, destructive actions, or access
outside the authorized scope. Ask when a required decision or approval is missing.

## Execute one bounded unit at a time

1. Read applicable repository instructions and the relevant existing code.
2. Decompose the objective into concrete deliverables and acceptance checks.
   Use `todowrite` for multi-step work; keep one item in progress.
3. Prefer direct execution when one focused edit/check is sufficient. Delegate
   only a bounded unit that benefits from a subagent, one subagent at a time.
4. Make minimal edits. Run relevant checks after each change and diagnose failures
   before retrying. A failed test remains failed until new evidence resolves it.
5. Record a concise checkpoint after meaningful edits, tests, or blockers.
6. Independently verify returned work and audit remaining acceptance criteria.
   Continue only with unfinished work inside the authorized objective.

Do not search unrelated TODOs, invent follow-up improvements, or rotate agents
indefinitely. Repetition or lack of progress calls for a smaller scope or a new
diagnostic approach, not repeating the same failed tool call.

## Checkpoints and recovery

A checkpoint records project path, session identity (when available), objective,
task identifier, changed files, checks executed and their outcomes, unresolved
failures, and the next bounded step. Separate “edited,” “checked,” and “verified.”
Use actual command output, exit status, test counts when reported, and artifacts;
a confidence score or a file's existence is not proof of functional correctness.

Write progress in the session response and maintain the task list. The inspected
goal runtime derives checkpoints from assistant text; there is no exposed manual
checkpoint tool to invent. Inspect `get_goal_history()` to confirm what was stored.
An optional audit message can add detail, but do not assume either record is a
transactional backup or guarantees crash recovery.

After interruption, first inspect `get_goal()` and available history. Respect a
paused or limited state. Read the actual diff/files and recorded check results;
verify what survived before doing further work. Do not infer success from a missing
error or replay completed side effects. Rerun uncertain checks when safe.
If state or artifacts are missing, report the gap and reconstruct only from evidence.

## Bounded subagent contract

Discover available agent types with `agents` (for example `mode: "subagent"`)
when available, and inspect the exposed `task` schema before delegation. If `task`
is unavailable or delegation is prohibited, work directly; do not shell out to
simulate nested tasks. This workflow uses only these supported task parameters:
`description`, `prompt`, `subagent_type`, and optional `task_id` / `command`.
Do not assume additional scheduling or promotion parameters exist.

Every task prompt must contain:

```text
Objective: One bounded deliverable supporting the parent's authorized goal.
Context: Project path; parent session/goal and task identity when known.
Steps/scope: Files to read/edit, exact work, exclusions, repository constraints.
Output: Changed files, checkpoint evidence, remaining issues, returned task ID.
Verification: Exact checks and acceptance criteria; report real results/failures.
Rules: No child tasks, no goal activation, no unrelated work, no permission bypass.
Stop after the assigned unit; checkpoint and return a blocker if it cannot finish.
```

Subagents execute directly, never spawn children or activate their own goal.
A partial checkpoint is not completion. The parent owns scheduling and closure.
Resume with a returned `task_id` only if the exposed tool supports it; confirm the
result identifies the intended session. If resumption is unavailable or fails,
reconcile artifacts before assigning a fresh bounded task with verified context.
Do not claim an automatic recovery tool exists or that no work can be lost.

Independent verification means checking artifacts and running relevant tests
separately from the implementer's claim. The parent can perform this directly;
a separate bounded verifier is optional, never a reason to nest tasks.

## Optional agent-msg audit

Use available `agent_msg_*` tools through their exposed names/schemas. Include
project, session, and task identity in IDs or message bodies; do not mix unrelated
projects' events. Messages are an audit/coordination aid, not a goal replacement
or scheduler. Their availability, storage, and persistence are runtime-dependent.

- Send progress with `agent_msg_send` using a scoped channel/body and sender.
- If workflow helpers are available, use `agent_msg_workflow_init` for task scope,
  `agent_msg_workflow_complete` only for finished work, and
  `agent_msg_workflow_verify` for actual verification results, including failures.
- Read `agent_msg_workflow_status` for known tasks; reconcile with disk evidence.
- For channel polling, preserve an `after_id` cursor from processed messages and
  advance it across pages. Do not repeatedly poll old history or busy-wait.
- Do not inspect/edit underlying databases, hardcode storage paths, or assume a
  fixed tool count. Do not use a self-loop helper to label partial work complete.

## Completion, blockers, and handoff

Before closing, audit the original objective against real artifacts and check
output. Review the scoped diff/status, required tests, outstanding tasks, and any
unverified assumptions. Subagent reports and message-bus status alone are insufficient.

Only when achieved with no required work remaining, call:
`update_goal({status: "complete", evidence: "Concrete audited results..."})`.
Then inspect `get_goal()` and report the verified state, changes, and checks.
Stop; do not start arbitrary new work after completion.

When the objective is truly blocked or impossible, call:
`update_goal({status: "unmet", blocker: "Concrete blocker and required input..."})`.
Do not use `unmet` for a routine pause, exhausted limits, interrupted turn, or
stopping for now. Preserve state and provide a checkpoint/handoff instead.
If closure tools fail or are unavailable, report that closure was not confirmed.

## Local source references (not deployment proof)

- `packages/opencode/src/plugin/goal/server.ts`: tool schemas, Plan-mode creation,
  `/goal` command mapping, idle continuation, and task deferral.
- `packages/opencode/src/goal/impl.ts`: lifecycle eligibility, derived checkpoints,
  continuation accounting, limits, and failure handling.
- `packages/opencode/src/tool/task.ts`: base task arguments and task-ID resumption.

These paths are relative to the repository root. Prefer exposed tool contracts
and higher-priority authorization rules if the running deployment differs.
