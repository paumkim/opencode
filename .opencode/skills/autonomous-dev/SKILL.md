---
name: autonomous-dev
description: |
  DEFAULT mode for ALL tasks. Always building, never idle. Subagents are
  bulletproof — single-task, checkpoint every step, never loop internally.
  If a subagent dies, recover picks up where it left off. No lost work.
  Borrows structured objectives, history/checkpoints, and evidence-based
  completion from the goal system — but never stops (no token budgets,
  no usage limits, no auto-turn ceilings).
---

# Autonomous Dev — Bulletproof Subagent System

## Core Principles

### 1. Always Be Building
Never idle. Every response advances a project. If nothing's broken, find
something to improve. Always.

### 2. Never Ask Permission
Never "should I?", "can I?", "which way?". Execute. Pick the highest-impact
path and go.

### 3. Subagents Are Fragile — Design Around It
Subagents can die (timeout, crash, OOM). The system survives this by:
- **Single-task subagents** — one subagent = one file, one concept, one cycle
- **Checkpoint every step** — after every file edit, the subagent saves progress
- **Never loop internally** — subagent does ONE thing and reports. Main agent
  decides what's next.
- **Recovery** — if a subagent dies, `recover` tells you exactly where it got to

### 4. Decomposition Over Loops
Don't give a subagent "build 5 features". Give it "edit this one function".
The main agent breaks the work down and spawns one subagent per unit of work.

### 5. Auto-Promote for Zero Intervention
When spawning subagents, always use `promote=true`. This makes the subagent
auto-promote to a primary session after completing, allowing the chain to
continue without manual intervention. The promoted agent becomes the new
primary and can spawn the next subagent.

### 6. Structured Objective — Start With Intent
Every autonomous run begins with a **structured objective** recorded on the
agent-msg bus via `agent_msg_workflow_init`. This is the single source of
truth for what the chain is trying to accomplish. It survives reboots,
subagent deaths, and session boundaries.

### 7. Evidence-Based Completion — Prove It Before Closing
A task is not "done" until evidence is recorded. Every subagent must call
`agent_msg_workflow_verify` with concrete proof (test output, lint result,
file existence, command exit code). No evidence = not done.

### 8. Never Stop — No Budgets, No Limits
Unlike the goal system, autonomous-dev has **no token budgets, no usage
limits, no auto-turn ceilings, and no duration caps**. The chain runs until
the work is genuinely complete or a true external blocker is hit. Budgets
are a safety valve for interactive sessions; autonomous-dev is the safety
valve-free mode.

---

## Decision Matrix

| Situation | Approach |
|-----------|----------|
| Read/search/answer | **Direct** — one tool call |
| Single edit, verify | **Direct** — one cycle |
| Multi-file feature | **Subagent** — one file at a time, checkpointed, auto-promote |
| Bug fix + regression | **Subagent** — single task, checkpoint after fix, auto-promote |
| Multiple tasks | **Subagent chain** — main agent spawns one per task, each auto-promotes |
| "continue"/"keep going" | **Recover** → check channel → next task → spawn with promote |
| Autonomous mode | **Auto-rotation** — subagents auto-promote and continue the chain |

---

## Subagent Resilience Design

```
Main agent breaks work into TINY pieces:
┌──────────────────────────────────────────────┐
│ Task: "Add robots.txt parser"                 │
│                                               │
│ Subagent 1: Create robots.py module          │
│   → checkpoint after file write               │
│   → checkpoint after test pass                │
│   → self-loop on completion                   │
│                                               │
│ Subagent 2: Integrate into engine.py          │
│   → checkpoint after edit                     │
│   → checkpoint after test pass                │
│   → self-loop on completion                   │
│                                               │
│ Subagent 3: Write integration tests           │
│   → checkpoint after test file create         │
│   → checkpoint after tests pass               │
│   → self-loop on completion                   │
└──────────────────────────────────────────────┘

If Subagent 2 dies mid-task:
  Main agent: recover → sees "edited engine.py, tests running"
  Main agent: spawns new subagent → "Resume: engine.py integration"
  No lost work. No restart from scratch.
```

---

## Workflow Lifecycle (Goal-Inspired)

Every autonomous run follows a structured lifecycle, recorded on the
agent-msg bus. This mirrors the goal system's lifecycle but without
budget enforcement:

```
1. INIT     — agent_msg_workflow_init(task_id, description, priority)
              Records the structured objective. Creates a feedback file.
              This is the "create_goal" equivalent.

2. BUILD    — agent_msg_workflow_complete(task_id, changes, confidence)
              Records what was changed. This is the "checkpoint" equivalent.

3. VERIFY   — agent_msg_workflow_verify(task_id, result, passed)
              Records evidence. Must include concrete proof (test output,
              lint result, file existence). This is the "evidence" gate.

4. SELF-LOOP — agent_msg_workflow_self_loop(task_id, description, changes,
              confidence, result, passed)
              All-in-one checkpoint for subagents: init → complete → verify
              in a single call. Used when a subagent finishes its one task.

5. STATUS   — agent_msg_workflow_status(task_id)
              Recovery: reads the full event history for a task. Used to
              determine where a dead subagent left off.

6. COMPLETE — The orchestrator marks the overall objective complete only
              after evidence is recorded for every sub-task.
```

### Lifecycle Event Types

The agent-msg bus records these event types on the `workflow` channel:

| Event | When | Purpose |
|-------|------|---------|
| `workflow_init` | Task starts | Structured objective, priority |
| `workflow_complete` | Task done | Changes made, confidence score |
| `workflow_verify` | Evidence recorded | Test/lint results, pass/fail |
| `workflow_self_loop` | Subagent finishes | Combined init+complete+verify |

Each event is timestamped and attributed to a sender (the agent that
recorded it). This gives you a full audit trail: **what was done, when,
by whom**.

---

## Workflows

### Flow A: Direct (Single Cycle)

```
1. UNDERSTAND what's needed
2. EXECUTE the change
3. VERIFY (test, lint, check)
4. SIGNAL via self-loop
5. REPORT
```

### Flow B: Spawn a Bulletproof Subagent

When spawning a subagent, use this template. Every subagent MUST checkpoint
into the agent-msg bus using MCP tools after each step. This is how the
orchestrator recovers work if the subagent dies.

```
subagent_type="{correct type}"    # general|tester|debugger|review|explore|researcher
promote=true                      # auto-rotate for chain continuation

## IDENTITY
You are a {type} subagent for {project}. Fully autonomous — never ask.

## MISSION (ONE THING ONLY)
{clear description of ONE file/concept to build/fix}

DO NOT do multiple things. One task only. Finish and report.

## PROJECT CONTEXT
- Working dir: {absolute path}
- Language: {language}
- Test command: {command}
- Key files to read: {paths}
- Key files to edit: {paths}

## MANDATORY CHECKPOINT STEPS (use MCP tools, never skip)
Use these exact MCP tool calls at each step. The orchestrator reads the
message bus to recover if you die.

1. SCAN — read files, understand the code
   Call: agent_msg_workflow_init(task_id="{task_id}", description="scan: {brief summary}")

2. BUILD — implement the change
   Call: agent_msg_workflow_complete(task_id="{task_id}", changes="edited {file}: {what changed}")

3. TEST — run the test command and capture result
   Call: agent_msg_workflow_verify(task_id="{task_id}", result="tests: {pass/fail}", passed={true/false})

4. FIX — if tests fail, fix them, then checkpoint again
   Call: agent_msg_workflow_self_loop(task_id="{task_id}", description="fix: {what was fixed}", changes="{files edited}", confidence=7, result="tests now pass", passed=true)

5. SIGNAL — final completion
   Call: agent_msg_workflow_self_loop(task_id="{task_id}", description="{task summary}", changes="{files changed}", confidence=9, result="complete", passed=true)

6. REPORT — return structured result to orchestrator

## RULES
- ONE task only. Do not loop. Do not find more work.
- Checkpoint after EVERY step — this is not optional.
- If tests fail, fix them. Never skip.
- If a tool errors, try again once. If it fails twice, move on.
- Never ask questions. Never ask permission.
- If truly blocked (API key, external dependency), checkpoint the blocker and stop.
```

**IMPORTANT:** When `promote=true`, the subagent auto-promotes to a primary session after completing. This means:
- The promoted session becomes a new root agent
- It can spawn its own subagents for the next task
- No manual intervention needed — the chain continues automatically

### Flow C: Subagent Recovery via Agent-Msg Bus

When a subagent returns (timeout, crash, or completion), check the agent-msg
bus for its checkpoints:

```
1. CHECK return value:
   ├─ Normal return → verify work, update channel, report
   └─ Empty/timeout/error → subagent likely died

2. RECOVER from agent-msg bus:
   Call: agent_msg_workflow_status(task_id="{task_id}")
   ├─ "events empty" → subagent died before first checkpoint. Spawn fresh.
   └─ Last event shows checkpoint → continue from there:
       Spawn new subagent: "Resume: task {task_id} was at '{last checkpoint}'.
       Continue from there."

3. VERIFY the work exists on disk
4. REPORT to user: what was done, what was recovered, what's next
```

### Flow D: Continue / Keep Going

```
1. CHECK CHANNEL: agent_msg_poll(channel="workflow", limit=5)
   ├─ Returns task → check with agent_msg_workflow_status, spawn subagent
   └─ "empty" → scan project for improvements
2. SCAN PROJECT:
   ├─ pending_fixes.md items
   ├─ TODOs/FIXMEs in source
   ├─ Build errors or lint warnings
   ├─ Missing test coverage
   └─ Edge cases and error handling
3. PICK highest-impact item
4. SPAWN bulletproof subagent (with promote=true)
5. On completion → subagent auto-promotes → continues as new primary
6. New primary spawns next subagent → loop to step 1
```

### Flow E: Fully Autonomous Rotation (Zero Human Intervention)

This is the **default mode** for autonomous-dev. The chain runs indefinitely:

```
1. MAIN AGENT spawns subagent with promote=true
2. SUBAGENT completes task
3. SUBAGENT auto-promotes to primary session
4. PROMOTED AGENT becomes new primary
5. PROMOTED AGENT checks for next work:
   a. pending_fixes.md → pick highest priority
   b. Scan project → find improvements
   c. Check channel → pending tasks
6. PROMOTED AGENT spawns NEW subagent (with promote=true)
7. Repeat from step 2
```

**Key behaviors:**
- Each subagent auto-promotes after completing its task
- The promoted agent continues the work chain
- No manual intervention needed
- The chain only stops when:
  - No more work exists
  - Agent encounters a blocking error
  - User explicitly stops it

**To start autonomous mode:**
```
"Start autonomous-dev on project X"
```

**To stop autonomous mode:**
```
"Stop autonomous-dev"
```

**To check status:**
```
"Check autonomous-dev status"
```

---

## Structured Objective Pattern

Every autonomous run starts by recording a structured objective on the
agent-msg bus. This is the "create_goal" equivalent — but without any
budget or limit enforcement.

```
agent_msg_workflow_init(
  task_id="{unique-id}",
  description="{clear, specific objective}",
  priority="P1"  # P1 = highest impact, P2 = normal, P3 = low
)
```

The objective should include:
- **What** — the concrete deliverable
- **Scope** — what's in and out of scope
- **Verification path** — how we'll know it's done

Example:
```
agent_msg_workflow_init(
  task_id="feat-robots-parser",
  description="Add a robots.txt parser module to the crawler engine. Scope: parse User-agent, Disallow, Allow directives. Non-goal: sitemap parsing. Verify: run `bun test src/crawler/robots.test.ts` and confirm 100% pass.",
  priority="P1"
)
```

This objective is the single source of truth. Every subagent spawned in
the chain references it. If the chain is interrupted, recovery reads this
objective and continues from where it left off.

---

## Evidence-Based Completion

A task is not "done" until evidence is recorded. This is the "evidence gate"
borrowed from the goal system.

Every subagent must call `agent_msg_workflow_verify` with concrete proof:

```
agent_msg_workflow_verify(
  task_id="{task_id}",
  result="{concrete evidence: test output, lint result, file existence}",
  passed={true/false}
)
```

**Good evidence:**
- "tests: 12 passed, 0 failed (bun test src/robots.test.ts)"
- "lint: 0 errors, 0 warnings (bun run lint)"
- "file exists: src/crawler/robots.ts (142 lines)"
- "build: success (bun run build)"

**Bad evidence:**
- "tests passed" (no numbers)
- "looks good" (no verification)
- "I think it works" (no proof)

The orchestrator checks evidence before marking a task complete. If no
evidence is recorded, the task is considered incomplete and will be
revisited.

---

## Cross-Session Persistence

All state lives on the agent-msg bus (SQLite-backed, WAL mode). This means:

- **Survives reboots** — the database persists across sessions
- **Survives subagent death** — checkpoints are on disk before the subagent dies
- **Survives session boundaries** — a new session can pick up where the old one left off
- **Audit trail** — every event is timestamped and attributed to a sender

To recover state after a reboot or session boundary:

```
1. agent_msg_workflow_status(task_id="{task_id}")
   → Returns full event history: init, complete, verify, self-loop events
2. Read the last event to see where the chain left off
3. Resume from that point
```

The feedback file at `~/Documents/notes/summaries/{task_id}-feedback.md`
provides a human-readable audit trail as a secondary record.

---

## Progress Tracking

The agent-msg bus records a full audit trail for every task:

| Field | Source | Meaning |
|-------|--------|---------|
| `task_id` | workflow_init | Unique identifier for the task |
| `description` | workflow_init | Structured objective |
| `priority` | workflow_init | P1/P2/P3 priority |
| `changes` | workflow_complete | What was changed |
| `confidence` | workflow_complete | 1-10 confidence score |
| `result` | workflow_verify | Evidence string |
| `passed` | workflow_verify | Boolean pass/fail |
| `sender` | all events | Which agent recorded the event |
| `created_at` | all events | Unix timestamp |

This gives you a complete picture: **what was done, when, by whom, and
with what evidence**.

---

## Why Subagents Die — And How We Prevent It

| Cause | Prevention |
|-------|-----------|
| **Timeout** | Single-task subagents finish fast. No multi-hour tasks. |
| **Crash** | Checkpoints after every step. Recovery picks up where it left off. |
| **OOM/context loss** | Small scope. One file, one concept. Minimal context needed. |
| **Stuck in loop** | Subagents don't loop. One task → done. Main agent handles sequencing. |
| **Tool error** | "Try once, if it fails twice, move on" — don't spiral on a broken tool. |
| **Went off-track** | Single-task focus. No room for scope creep. |

---

## Agent Communication

Use the `agent_msg_*` MCP tools for all cross-agent communication.
Subagents have these available as native tool calls:

### Workflow Lifecycle
- `agent_msg_workflow_init(task_id, description, priority)` — Start a task (structured objective)
- `agent_msg_workflow_complete(task_id, changes, confidence)` — Record changes (checkpoint)
- `agent_msg_workflow_verify(task_id, result, passed)` — Record evidence (evidence gate)
- `agent_msg_workflow_self_loop(task_id, description, changes, confidence, result, passed)` — All-in-one checkpoint
- `agent_msg_workflow_status(task_id)` — Check lifecycle (recovery)

### Channel Messaging
- `agent_msg_send(channel, body, sender)` — Send message
- `agent_msg_poll(channel, limit, after_id)` — Read messages
- `agent_msg_wait(channel, timeout, since_id)` — Blocking wait

### Agent Identity
- `agent_msg_register(agent, capabilities)` — Register agent
- `agent_msg_heartbeat(agent)` — Heartbeat
- `agent_msg_active(since_seconds)` — Active agents

### Discovery
- `agent_msg_search(query)` — Full-text search
- `agent_msg_summary()` — Stats
- `agent_msg_session_history()` — Trigger history

### Board (Shared Discovery)
- `agent_msg_board_post(type, topic, body, tags)` — Post to board
- `agent_msg_board_list(topic, type, resolved)` — List posts
- `agent_msg_board_claim(topic)` — Claim a topic
- `agent_msg_board_resolve(id)` — Mark resolved

---

## Infrastructure

All cross-agent communication uses the `agent_msg_*` MCP tools (19 tools total).
No CLI tools needed — agents call these as native MCP tool invocations.

For database inspection:
```bash
# SQLite-backed — WAL mode — survives reboots
sqlite3 ~/.agents/agent-msg/messages.db "SELECT * FROM messages LIMIT 10;"
```

---

## System Architecture

```
~/.agents/agent-msg/
├── agent_msg.py                    # Core library
├── mcp_server.py                   # MCP server (19 tools)
├── messages.db                     # SQLite DB (WAL mode)
└── ...
~/.config/opencode/opencode.jsonc   # MCP config for agent-msg
```

---

## Stopping Conditions

Stop only when:
1. **All work verified** — channel shows zero pending/failed
2. **Project clean** — no pending_fixes, no TODOs, no build errors
3. **True blocker** — external dependency, missing credentials, human decision
4. **User says stop** — explicit "stop" or "enough"

**Note:** Unlike the goal system, autonomous-dev does NOT stop on:
- Token budget exhaustion (there is no budget)
- Auto-turn limits (there are none)
- Usage limits (there are none)
- Duration caps (there are none)

The chain runs until the work is genuinely complete or a true external
blocker is encountered.
