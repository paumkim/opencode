---
name: project-loader
description: >
  Design entry point for a proposed autonomous robotics workflow, not an
  executable natural-language loader. Describes meta-control coordination of
  specialized loops (sensorimotor, planning, learning, attention, homeostasis,
  social, memory, error-correction, resource).
  Trigger phrase: "load loops, work on project X".
---

# Project Loader

**Proposed trigger phrase:** *"load loops, work on project X"* (not a runtime command).

## Current Status and Safety Boundary

The implementation in `src/` is a **generic software supervisory runtime**:
module discovery, lifecycle management, sequential scheduling, cooperative
cancellation, and a software interlock/watchdog. All ten robot loops currently
contain only `SKILL.md` design specifications, not runnable modules. The skills
and templates below are documented designs, not implemented robot policies.

There is **no hardware safety certification, actuator enforcement, real-time or
latency guarantee, persistence/resume, DAG execution, or adaptive scheduling**.
This Markdown file does not parse tasks or activate a robot. The architecture,
protocols, and walkthrough below describe proposed behavior unless explicitly
identified as current software semantics.

Physical operation would require independent, always-on physical monitoring and
protective controls **outside this sequential JavaScript runtime**, including
while foreground context changes or homeostasis is inactive. JavaScript timers,
abort signals, and software admission checks are not emergency stops. Hardware
limits must remain immutable to learning and task-priority changes; adaptive
advisory setpoints must stay inside those limits. Learned-policy deployment
requires validation, explicit operator approval, and a rollback plan. These
physical safeguards and deployment gates are requirements, **not implemented
features**.

---

## Architecture Overview (Design)

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

**Current discovery semantics** (`src/registry.ts`): the default `activeOnly`
option filters directories by the presence of `SKILL.md`; despite its name,
it does not indicate lifecycle activation. `getAvailableNames()` lists discovered
directories. Directories without `SKILL.md` require `activeOnly: false` to appear.
`getNames()` lists runnable registrations only: a supported JS/TS module must
export a valid loop object. SKILL-only directories have no runnable registration;
`getActiveNames()` lists loops whose lifecycle has been activated.

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

### 5. Lazy-Load (Design) vs Current Import Semantics

Design intent: only the loops needed for the current sub-task are activated,
and a loop is deactivated when no pending sub-task needs it.

Current software semantics (`src/registry.ts`, `src/runtime.ts`):

- Directory listing does not execute code, but runnable-module discovery uses
  dynamic imports during registry/runtime creation, before lifecycle activation.
  Module top-level code can execute then; discovery is not a sandbox or a safety
  gate. Repeated imports of the same URL use the JavaScript module cache.
- `activate()` invokes `init()`; successful teardown clears registry context and
  changes lifecycle state to `unloaded`. Resource release depends on the loop's
  implementation. Neither deactivation nor teardown evicts imported code.
- Multiple loops can remain lifecycle-active. `eager: true` requests activation
  of all registrations; `Runtime` defers that activation until startup checks.
  Successful `runLoop`/`runSequence` calls do not automatically deactivate loops.
  Sequential execution is not a single-context or bounded-memory guarantee.

### 6. Activate

Each loop implements this interface (`src/types.ts`); the runtime passes an
optional `AbortSignal` to `init` and `run`:

```
loop.init(context, signal?)   — load configuration, allocate resources
loop.run(input, signal?)      — execute one iteration, return LoopResult
loop.status()                 — report health, resource usage, confidence
loop.teardown()               — release resources
```

Current software semantics: cancellation is **cooperative** — aborting the
signal requests cancellation, but a loop that ignores it keeps running until
its work settles; cleanup runs after settlement. `runSequence` forwards each
loop's `result.data` as the next loop's input. `teardown()` neither persists
state (no persistence exists) nor unloads imported code.

---

## Coordination Protocol

### Loop Communication

Current software passes context to initialization and forwards `result.data`
between steps of `Runtime.runSequence`. The scheduler executes a supplied list
in order, not a task graph; it does not interpret recommendations or apply robot
policies. `LoopResult` has this shape (`src/types.ts`; confidence is not range-validated):

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

### Default Sequencing (Design)

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

### Adaptive Re-sequencing (Design, Not Implemented)

The meta-control loop would monitor results and re-sequence dynamically:

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

## Foreground Context and Physical Monitoring

A single **foreground reasoning context** is a proposed way to limit document
context, not a restriction on retained module instances or a physical control
strategy. Switching that context must never switch off required physical
monitoring. Independent, always-on protective controls would have to remain
operational outside the sequential JS runtime throughout any physical task.

Current software can initialize on demand and forward `result.data`, but keeps
successful loops active until explicitly deactivated/stopped. Imported code,
loop-owned references, context, and returned results may remain in memory;
there is no bounded-memory guarantee. Persisting checkpoints and resuming robot
missions are unimplemented design work.

### Software Halt and Reset (Implemented, Not Physical Clearance)

`SafetyInterlock` evaluates caller-supplied rules; it includes no robot-specific
policy. Critical violations and predicate exceptions latch a software halt;
warnings do not stop evaluation of later rules. `clearViolations()` clears only
history, **not the halt latch**. An explicit `reset()` rearms software admission
and clears the latched violation, but preserves history. It does not verify
physical conditions, authorize motion, or certify recovery. Physical clearance
and any operator approval must be established independently; those gates are
not implemented here. Watchdog timers share the JS event loop, so they cannot
guarantee detection latency or preempt blocked/non-cooperative work.

A software halt/watchdog violation does not itself abort an in-flight operation's AbortSignal. In-flight work may continue until it settles; admission checks reject further work when reached. Signal cancellation is a separate mechanism.

---

## Example Walkthrough (Conceptual)

This walkthrough is a **conceptual illustration of the proposed workflow**, not
a record of an executed run. No robot, sensor, or actuator is involved; the
numbers are illustrative. It also assumes the unimplemented design properties
above (single active context, checkpointing, adaptive re-sequencing).

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
- **Unload**: Deactivate advisory homeostasis; independent protective monitoring remains operational.
  Unload planning (path complete).
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
├── project-loader.md          ← THIS FILE (design entry point)
├── loops/
│   ├── meta-control/SKILL.md  ← orchestrator (design spec)
│   ├── sensorimotor/SKILL.md  ← reflex layer (design spec)
│   ├── planning/SKILL.md      ← strategic layer (design spec)
│   ├── learning/SKILL.md      ← adaptation layer (design spec)
│   ├── attention/SKILL.md     ← saliency and focus selection (design spec)
│   ├── homeostasis/SKILL.md   ← battery, temperature, safety margins (design spec)
│   ├── memory/SKILL.md        ← episodic + semantic storage and recall (design spec)
│   ├── error-correction/SKILL.md ← anomaly detection and recovery (design spec)
│   ├── resource/SKILL.md      ← compute, power, bandwidth allocation (design spec)
│   └── social/SKILL.md        ← human interaction and communication (design spec)
├── skills/
│   ├── navigate/SKILL.md      ← path planning and obstacle avoidance (design spec)
│   ├── manipulate/SKILL.md    ← grasping, lifting, tool use (design spec)
│   ├── communicate/SKILL.md   ← human interaction, status reporting (design spec)
│   └── learn/SKILL.md         ← skill acquisition and policy tuning (design spec)
└── templates/
    ├── cpg-template/SKILL.md  ← central pattern generators (rhythmic motion) (design spec)
    ├── fsm-template/SKILL.md  ← finite state machines (discrete states) (design spec)
    ├── rl-template/SKILL.md   ← reinforcement learning (policy optimization) (design spec)
    └── predictor-template/SKILL.md ← predictive models (outcome forecasting) (design spec)
```

---

## Quick Reference

| Command | Effect |
|---------|--------|
| `load loops, work on project X` | Proposed trigger for the design workflow (no runtime command exists) |
| `load loops, work on project X` (with prior context) | Proposed: resume from last checkpoint, reuse learned models (persistence unimplemented) |
| `load loops, work on project X` (with constraints) | Proposed: apply constraints during decomposition |

**Trigger phrase (proposed):** `load loops, work on project`

**Entry point:** This file (`project-loader.md`)

**Orchestrator:** `loops/meta-control/SKILL.md`

**Loops with SKILL.md (design specs, not runnable modules):** `meta-control`,
`sensorimotor`, `planning`, `learning`, `attention`, `homeostasis`, `memory`,
`error-correction`, `resource`, `social` — all 10 present as design specs

**Templates (design specs):** `cpg-template`, `fsm-template`, `rl-template`, `predictor-template`

**Skills (design specs):** `navigate`, `manipulate`, `communicate`, `learn`
