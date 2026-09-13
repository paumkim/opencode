---
name: meta-control
description: >
  The meta-control loop is the top-level orchestrator for the autonomous robotics
  framework. It receives a project or task, decomposes it into sub-tasks, identifies
  which of the ten specialized loops (sensorimotor, planning, learning, attention,
  homeostasis, social, memory, error-correction, resource) are required, lazily loads
  only those loops, coordinates their execution, and returns results to the user.
  Designed as a proactive researcher-agent: it breaks down problems, sequences loops
  adaptively, and re-plans based on intermediate results.
---

# Meta-Control Loop

## Role

The meta-control loop is the **conductor** of the autonomous robotics framework. It does not execute domain logic itself — it decides *what* to run, *when*, and *how to sequence it*.

## Lifecycle

```
1. Receive project/task
2. Decompose into sub-tasks
3. Map sub-tasks → required loops + skills
4. Lazy-load only the needed loops
5. Execute loops in adaptive sequence
6. Collect & synthesize results
7. Return to user (or point to next skill/template)
```

## Step 1 — Receive & Parse

Accept a project description from the user. Extract:

- **Goal**: the high-level objective (e.g., "navigate to a room and manipulate an object")
- **Constraints**: hardware limits, time budget, safety boundaries
- **Available resources**: which skills/templates are installed
- **Context**: prior results, environment state, learned models

## Step 2 — Decompose

Break the project into sub-tasks using a researcher mindset:

1. **What capabilities are needed?** (perception, motion, reasoning, learning)
2. **What is the dependency order?** (sensorimotor before planning; memory before learning)
3. **What can run in parallel?** (attention + homeostasis are independent of planning)
4. **What are the failure modes?** (sensor loss, actuator saturation, model drift)

Produce a **task graph** — a DAG of sub-tasks with edges representing data or control dependencies.

## Step 3 — Map to Loops

Each sub-task maps to one or more of the ten loops:

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

**Lazy loading**: Only load a loop's module when its sub-task is scheduled. Unload when idle to free resources.

## Step 4 — Sequence & Coordinate

### Default sequencing (bottom-up):

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

### Adaptive re-sequencing:

- If **learning** detects a performance gap → re-run **planning** with updated model
- If **error-correction** detects an anomaly → pause **sensorimotor**, engage **homeostasis**
- If **attention** finds a salient event → interrupt **planning**, re-prioritize
- If **resource** is constrained → throttle **learning**, defer non-critical loops

### Coordination protocol:

Each loop exposes:
- `init(context)` — load configuration, allocate resources
- `run(input)` — execute one iteration, return `LoopResult`
- `status()` — report health, resource usage, confidence
- `teardown()` — release resources, persist state

The meta-control loop calls these in sequence, passing `LoopResult` from one to the next as input.

## Step 5 — Point to Next Skill/Template

After each loop completes, the meta-control loop decides the next step:

- **If sub-task succeeded** → advance to the next sub-task in the graph
- **If sub-task failed** → engage `error-correction` loop, then retry or re-plan
- **If performance is suboptimal** → engage `learning` loop, then re-plan
- **If all sub-tasks complete** → synthesize final result, return to user

The meta-control loop also recommends which **template** to use for each loop:

| Loop | Recommended Template |
|------|---------------------|
| sensorimotor | `cpg-template` (rhythmic patterns) or `fsm-template` (discrete states) |
| planning | `fsm-template` (task sequencing) |
| learning | `rl-template` (policy optimization) |
| attention | `predictor-template` (saliency prediction) |
| memory | `predictor-template` (retrieval scoring) |
| error-correction | `fsm-template` (recovery states) |
| resource | `predictor-template` (allocation prediction) |

## Step 6 — Return Results

Aggregate results from all executed loops into a final report:

- **What was accomplished**: goal achievement status
- **What was learned**: new policies, updated models, discovered anomalies
- **What to do next**: recommended follow-up tasks, suggested skill/template combinations
- **Resource summary**: energy used, time elapsed, confidence levels

## Proactive Research Behavior

The meta-control loop thinks like a researcher:

1. **Hypothesis formation**: "To achieve X, I need Y capability. My current loops suggest Z approach."
2. **Experiment design**: "I'll try loop sequence A→B→C first; if B fails, fall back to A→D→C."
3. **Evidence gathering**: Collect `LoopResult` from each loop, look for patterns.
4. **Adaptation**: If results don't match expectations, re-decompose and re-sequence.
5. **Knowledge retention**: Store successful loop combinations in `memory` for future projects.

## Integration Points

- **Skills** (`skills/`): Concrete capabilities (navigate, manipulate, communicate, learn) that loops invoke
- **Templates** (`templates/`): Reusable loop implementations (CPG, RL, FSM, predictor) that loops instantiate
- **User**: Receives final results and recommendations for next steps

## Usage

```
meta-control.run(project="Navigate to the kitchen and fetch a soda")
  → decompose: [navigate, manipulate, communicate]
  → load loops: sensorimotor, planning, attention, memory
  → execute: sensorimotor → attention → planning → memory
  → result: "Reached kitchen, soda not found. Suggest: re-run with learning loop to update object database."
```
