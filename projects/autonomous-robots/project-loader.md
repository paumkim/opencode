---
name: project-loader
description: >
  Entry point for the autonomous robotics framework. Receives a project or task
  description from the user, activates the meta-control loop, and coordinates the
  lazy loading and sequencing of specialized loops (sensorimotor, planning,
  learning, attention, homeostasis, social, memory, error-correction, resource).
  Trigger phrase: "load loops, work on project X".
---

# Project Loader

**To use:** say *"load loops, work on project X"*

The project loader is the user-facing entry point for the autonomous robotics
framework. It is the single command that activates the entire system — from
project decomposition to loop orchestration to result delivery.

---

## Architecture Overview

```
User
  │
  │  "load loops, work on project X"
  ▼
┌─────────────────────────────────────┐
│         Project Loader              │
│  (this file — the entry point)      │
└──────────────┬──────────────────────┘
               │
               │  activates
               ▼
┌─────────────────────────────────────┐
│       Meta-Control Loop             │
│  (decompose → map → sequence →      │
│   coordinate → return)              │
└──────────────┬──────────────────────┘
               │
               │  lazy-loads only what's needed
               ▼
  ┌────────┬────────┬────────┬────────┬──────────┐
  │sensor- │planning│learning│attention│homeostasis│ ...
  │motor   │        │        │        │          │
  └────────┴────────┴────────┴────────┴──────────┘
               │
               │  each loop reports back
               ▼
  ┌────────┬────────┬────────┬────────┬──────────┐
  │skills/ │templates/│skills/ │skills/ │skills/   │
  │navigate│cpg,fsm, │manipulate│communicate│learn   │
  │        │rl,predictor│        │          │        │
  └────────┴────────┴────────┴────────┴──────────┘
               │
               │  results synthesized
               ▼
  User ← final report + next-step recommendations
```

---

## Loading Protocol

### 1. Receive

The loader accepts a natural-language project description from the user.

```
Input: "load loops, work on project <description>"
```

The description is passed verbatim to the **meta-control loop**, which parses it
into:

- **Goal** — the high-level objective
- **Constraints** — hardware limits, time budget, safety boundaries
- **Available resources** — installed skills and templates
- **Context** — prior results, environment state, learned models

### 2. Discover

The meta-control loop scans the project directory structure to discover what is
available:

```
loops/                 — 10 specialized control loops
  ├── meta-control/    — orchestrator (this system's brain)
  ├── sensorimotor/    — real-time sense → act cycles
  ├── planning/        — goal → trajectory → action sequences
  ├── learning/        — policy improvement from experience
  ├── attention/       — saliency and focus selection
  ├── homeostasis/     — battery, temperature, safety margins
  ├── memory/          — episodic + semantic storage and recall
  ├── error-correction/ — anomaly detection and recovery
  ├── resource/        — compute, power, bandwidth allocation
  └── social/          — human interaction and communication

skills/                — concrete capabilities
  ├── navigate/        — path planning and obstacle avoidance
  ├── manipulate/      — grasping, lifting, tool use
  ├── communicate/     — human interaction, status reporting
  └── learn/           — skill acquisition and policy tuning

templates/             — reusable loop implementations
  ├── cpg-template/    — central pattern generators (rhythmic motion)
  ├── fsm-template/    — finite state machines (discrete states)
  ├── rl-template/     — reinforcement learning (policy optimization)
  └── predictor-template/ — predictive models (outcome forecasting)
```

Only loops with a `SKILL.md` file are considered **active**. Empty directories
are registered as available but not yet implemented.

### 3. Decompose

The meta-control loop breaks the project into sub-tasks using a researcher
mindset:

1. **What capabilities are needed?** — perception, motion, reasoning, learning
2. **What is the dependency order?** — sensorimotor before planning; memory before learning
3. **What can run in parallel?** — attention + homeostasis are independent of planning
4. **What are the failure modes?** — sensor loss, actuator saturation, model drift

This produces a **task graph** — a DAG of sub-tasks with edges representing data
or control dependencies.

### 4. Map

Each sub-task maps to one or more loops:

| Loop | Responsibility | When to activate |
|------|---------------|-----------------|
| **sensorimotor** | Raw sensor → action mapping, reflexes | Any physical interaction |
| **planning** | Goal → trajectory, task sequencing | Multi-step objectives |
| **learning** | Policy/value updates, adaptation | Performance gaps detected |
| **attention** | Saliency, focus selection | High-dimensional sensory input |
| **homeostasis** | Battery, temperature, safety margins | Resource monitoring needed |
| **social** | Human interaction, communication | Human-in-the-loop tasks |
| **memory** | Episodic + semantic storage, recall | History-dependent decisions |
| **error-correction** | Anomaly detection, recovery | Safety-critical or uncertain domains |
| **resource** | Compute, power, bandwidth allocation | Multi-loop contention |

### 5. Lazy-Load

**Only the loops needed for the current sub-task are loaded.** The loader does
not preload all 10 loops — it loads each loop's `SKILL.md` and associated
modules on demand, right before that loop's sub-task is scheduled.

When a loop finishes its sub-task and no other pending sub-task requires it,
the loop is **unloaded** — its context is cleared, freeing resources for the
next loop.

This is the primary mechanism for **avoiding context overload**: at any given
moment, only one loop's full context is active in memory.

### 6. Activate

Each loop is activated by calling its interface:

```
loop.init(context)     — load configuration, allocate resources
loop.run(input)        — execute one iteration, return LoopResult
loop.status()          — report health, resource usage, confidence
loop.teardown()        — release resources, persist state
```

The meta-control loop calls these in sequence, passing `LoopResult` from one
loop to the next as input.

---

## Coordination Protocol

### Loop Communication

Loops communicate through a **shared context object** that flows through the
task graph. Each `LoopResult` contains:

```typescript
interface LoopResult {
  status: "success" | "failure" | "partial"
  data: unknown              // loop-specific output
  confidence: number          // 0.0–1.0
  resources_used: ResourceReport
  anomalies: Anomaly[]        // detected issues
  next_recommendation: string // suggested next loop or template
}
```

### Default Sequencing

The bottom-up default sequence ensures foundational layers are established
before higher-level reasoning:

```
homeostasis ──┐
              ├──► sensorimotor ──► attention ──► planning ──► memory
resource ─────┘
                    ▲                     │
                    │                     ▼
              error-correction ◄── learning
                    ▲                     │
                    │                     ▼
              social (if human-in-loop)
```

### Adaptive Re-sequencing

The meta-control loop monitors results and re-sequences dynamically:

- **Learning detects a performance gap** → re-run planning with updated model
- **Error-correction detects an anomaly** → pause sensorimotor, engage homeostasis
- **Attention finds a salient event** → interrupt planning, re-prioritize
- **Resource is constrained** → throttle learning, defer non-critical loops

### Template Selection

The meta-control loop recommends which template to use for each loop:

| Loop | Recommended Template |
|------|---------------------|
| sensorimotor | `cpg-template` (rhythmic) or `fsm-template` (discrete states) |
| planning | `fsm-template` (task sequencing) |
| learning | `rl-template` (policy optimization) |
| attention | `predictor-template` (saliency prediction) |
| memory | `predictor-template` (retrieval scoring) |
| error-correction | `fsm-template` (recovery states) |
| resource | `predictor-template` (allocation prediction) |

---

## Context Overload Avoidance

The system is designed so that **only one loop is fully loaded at a time**:

1. **Lazy loading** — loops are loaded only when their sub-task is scheduled,
   not at startup.
2. **Eager unloading** — when a loop's sub-task completes and no pending
   sub-task needs it, the loop is torn down and its context is cleared.
3. **Streaming handoff** — `LoopResult` is the only data passed between loops.
   The full context of the previous loop is not retained.
4. **Checkpointing** — critical state (learned policies, discovered anomalies,
   successful plans) is persisted to `memory` before a loop is unloaded, so it
   can be recalled later without keeping the loop active.

This means the system's memory footprint scales with the **complexity of the
current sub-task**, not the total number of loops in the framework.

---

## Example Walkthrough

**User input:**

> "load loops, work on project: build a robot that can navigate to a kitchen,
> identify a soda can on a shelf, and fetch it"

### Step 1 — Receive & Parse

The loader passes the description to meta-control, which extracts:

- **Goal**: Fetch a soda can from a kitchen shelf
- **Constraints**: Mobile robot with arm, limited battery, must not knock over objects
- **Resources**: navigate skill, manipulate skill, cpg-template, fsm-template, rl-template
- **Context**: None (first run)

### Step 2 — Decompose

Meta-control breaks this into sub-tasks:

1. `navigate_to(kitchen)` — get to the kitchen
2. `locate(soda_can)` — find the can on the shelf
3. `navigate_to(shelf)` — get close to the shelf
4. `grasp(soda_can)` — reach and pick up the can
5. `return_to(start)` — bring the can back

### Step 3 — Map to Loops

| Sub-task | Required Loops | Template |
|----------|---------------|----------|
| navigate_to(kitchen) | sensorimotor, planning, homeostasis | fsm-template |
| locate(soda_can) | sensorimotor, attention, memory | predictor-template |
| navigate_to(shelf) | sensorimotor, planning | fsm-template |
| grasp(soda_can) | sensorimotor, planning, learning | rl-template |
| return_to(start) | sensorimotor, planning, homeostasis | fsm-template |

### Step 4 — Execute (Lazy Loading)

**Sub-task 1: navigate_to(kitchen)**

- **Load**: sensorimotor, planning, homeostasis
- **Execute**: homeostasis checks battery → sensorimotor reads sensors → planning computes path → sensorimotor follows waypoints
- **Result**: Robot reaches kitchen entrance. Battery at 85%.
- **Unload**: homeostasis (no longer needed), planning (path complete)
- **Keep**: sensorimotor (still needed for next sub-task)

**Sub-task 2: locate(soda_can)**

- **Load**: attention, memory
- **Execute**: sensorimotor streams camera feed → attention detects salient red-and-blue object → memory recalls "soda can" visual signature → confirms match
- **Result**: Soda can located at shelf, coordinates (2.3m, 1.5m, 0.8m)
- **Unload**: attention, memory
- **Keep**: sensorimotor

**Sub-task 3: navigate_to(shelf)**

- **Load**: planning
- **Execute**: planning computes arm+base trajectory to shelf position
- **Result**: Robot positions itself under the shelf
- **Unload**: planning

**Sub-task 4: grasp(soda_can)**

- **Load**: planning, learning
- **Execute**: planning sequences arm motion → sensorimotor executes reach → grasp attempt fails (can is behind a bottle) → learning detects performance gap → planning recomputes with adjusted approach angle → grasp succeeds
- **Result**: Soda can grasped. Confidence: 0.92.
- **Unload**: planning, learning

**Sub-task 5: return_to(start)**

- **Load**: planning, homeostasis
- **Execute**: planning computes return path → homeostasis confirms battery sufficient → sensorimotor navigates back
- **Result**: Robot returns to start with soda can. Battery at 78%.
- **Unload**: all loops

### Step 5 — Return Results

The loader synthesizes a final report:

```
✅ Project complete: "Fetch soda can from kitchen"

What was accomplished:
  - Navigated to kitchen (battery: 85% → 78%)
  - Located soda can on shelf via visual recognition
  - Successfully grasped and retrieved the can

What was learned:
  - Updated grasp policy for occluded objects (stored in memory)
  - New "shelf-navigation" skill registered

What to do next:
  - Suggested: "load loops, work on project: open the soda can and pour it into a glass"
  - Template recommendation: manipulate skill + rl-template for fine motor control
```

---

## File Layout

```
autonomous-robots/
├── project-loader.md          ← THIS FILE (entry point)
├── loops/
│   ├── meta-control/SKILL.md  ← orchestrator (active)
│   ├── sensorimotor/SKILL.md  ← reflex layer (active)
│   ├── planning/SKILL.md      ← strategic layer (active)
│   ├── learning/SKILL.md      ← adaptation layer (active)
│   ├── attention/SKILL.md     ← saliency and focus selection (active)
│   ├── homeostasis/SKILL.md   ← battery, temperature, safety margins (active)
│   ├── memory/SKILL.md        ← episodic + semantic storage and recall (active)
│   ├── error-correction/SKILL.md ← anomaly detection and recovery (active)
│   ├── resource/SKILL.md      ← compute, power, bandwidth allocation (active)
│   └── social/SKILL.md        ← human interaction and communication (active)
├── skills/
│   ├── navigate/SKILL.md      ← path planning and obstacle avoidance (active)
│   ├── manipulate/SKILL.md    ← grasping, lifting, tool use (active)
│   ├── communicate/SKILL.md   ← human interaction, status reporting (active)
│   └── learn/SKILL.md         ← skill acquisition and policy tuning (active)
└── templates/
    ├── cpg-template/SKILL.md  ← central pattern generators (rhythmic motion) (active)
    ├── fsm-template/SKILL.md  ← finite state machines (discrete states) (active)
    ├── rl-template/SKILL.md   ← reinforcement learning (policy optimization) (active)
    └── predictor-template/SKILL.md ← predictive models (outcome forecasting) (active)
```

---

## Quick Reference

| Command | Effect |
|---------|--------|
| `load loops, work on project X` | Activate the full pipeline for project X |
| `load loops, work on project X` (with prior context) | Resume from last checkpoint, reuse learned models |
| `load loops, work on project X` (with constraints) | Apply constraints during decomposition |

**Trigger phrase:** `load loops, work on project`

**Entry point:** This file (`project-loader.md`)

**Orchestrator:** `loops/meta-control/SKILL.md`

**Active loops (have SKILL.md):** `meta-control`, `sensorimotor`, `planning`, `learning`, `attention`, `homeostasis`, `memory`, `error-correction`, `resource`, `social` — all 10 loops active

**Active templates:** `cpg-template`, `fsm-template`, `rl-template`, `predictor-template`

**Active skills:** `navigate`, `manipulate`, `communicate`, `learn`
