---
name: planning
description: >
  The planning loop handles goal-directed behavior and task sequencing. It takes
  high-level goals from meta-control, decomposes them into sub-goals, analyzes
  dependencies, plans trajectories and action sequences, assesses risk, and
  produces executable waypoints and task lists for the sensorimotor loop.
  Trigger keywords: planning, goal-directed, task sequencing, path planning,
  strategy, mission planning, roadmap, trajectory.
---

# Planning Loop

## Purpose

The planning loop is the **strategic layer** between meta-control's high-level
goals and sensorimotor's low-level execution. It transforms abstract objectives
into concrete, sequenced action plans. Where sensorimotor reacts to the present
moment, planning anticipates the future — reasoning about sequences of actions,
their dependencies, and their consequences over a finite horizon.

The core cycle is: **goal → decompose → plan → execute → monitor → replan**.

## Inputs

- **High-level goals** from `meta-control` — the objective to achieve (e.g.,
  "assemble the widget on the table")
- **Current state** from `sensorimotor` — the robot's pose, available objects,
  actuator status, and environmental layout
- **Resource status** from `resource` — available compute budget, power level,
  and bandwidth for plan execution
- **Historical context** from `memory` — prior successful/failed plans, learned
  cost models, and environmental changes observed over time

## Processing

Each planning cycle performs five stages:

1. **Goal decomposition** — break the high-level goal into a hierarchy of
   sub-goals (e.g., "assemble widget" → "navigate to table" → "grasp screwdriver"
   → "insert screw"). Each sub-goal becomes a node in a task graph.
2. **Dependency analysis** — determine ordering constraints between sub-goals.
   Some tasks must precede others (can't grasp before navigating); others can
   run in parallel (fetching two different tools simultaneously).
3. **Path/trajectory planning** — for each sub-goal, compute a feasible
   trajectory through state space. This may use A*, RRT, or learned cost models
   depending on the template selected.
4. **Risk assessment** — evaluate each candidate plan against failure modes:
   obstacle uncertainty, actuator limits, deadline pressure, and resource
   constraints. Assign a risk score to each plan branch.
5. **Plan selection** — choose the plan that maximizes expected utility while
   keeping risk below the configured tolerance.

## Outputs

- **Action sequences** — ordered lists of concrete actions for the
  sensorimotor loop to execute (e.g., `move_to(x,y) → rotate(theta) → grasp()`)
- **Waypoints** — intermediate spatial targets along a trajectory
- **Task lists** — the decomposed sub-goals with their dependency ordering
- **Sub-goals** — refined objectives passed back to meta-control for further
  decomposition if the plan exceeds the planning horizon

## Loop Cycle

```
goal → decompose → plan → execute → monitor → replan
```

| Stage | Description |
|-------|-------------|
| **goal** | Receive high-level objective from meta-control |
| **decompose** | Break goal into sub-goals, build task dependency graph |
| **plan** | Compute trajectories and action sequences for each sub-goal |
| **execute** | Dispatch action sequences to sensorimotor loop |
| **monitor** | Observe execution progress, detect deviations from plan |
| **replan** | If deviation exceeds threshold, recompute affected sub-goals |

## Templates

The planning loop selects a template based on the structure of the task and the
available models:

| Template | Use Case | Characteristics |
|----------|----------|-----------------|
| **FSM** (`fsm-template`) | Discrete, state-based planning | Task sequencing as a finite state machine. Each state represents a sub-goal; transitions fire when preconditions are met. Best for well-structured, predictable tasks with clear milestones. |
| **Predictor** (`predictor-template`) | Trajectory prediction | Uses a learned or analytical dynamics model to predict the outcome of action sequences before committing. Selects the trajectory whose predicted outcome best matches the goal. Supports multi-step lookahead. |
| **RL** (`rl-template`) | Adaptive planning | Learns a policy over the planning horizon through trial and reward. Adapts to environmental changes and novel situations. Requires exploration budget; best when the environment is partially unknown. |

## Integration

The planning loop sits in the **middle layer** of the control hierarchy:

- **Meta-control** (upstream): Receives high-level goals and reports progress.
  When planning completes a sub-goal, it signals meta-control to advance to the
  next sub-task in the task graph. If planning fails (no feasible plan found),
  it requests meta-control to re-decompose with relaxed constraints.
- **Sensorimotor** (downstream): Sends action sequences and waypoints for
  execution. Receives real-time feedback on execution status — whether each
  action succeeded, was interrupted, or produced an unexpected outcome.
- **Error-correction** (sideways): Receives deviation reports when execution
  diverges from the planned trajectory. If the deviation is recoverable,
  planning generates a local repair (re-plan just the affected segment). If
  not, it escalates to error-correction for anomaly diagnosis.
- **Memory** (sideways): Stores successful plans for reuse and retrieves
  historical plans when encountering similar goals. Also receives updated cost
  models from the learning loop.
- **Resource** (sideways): Queries available compute and power before committing
  to computationally expensive plans (e.g., RL exploration). Reports plan
  resource requirements so resource can arbitrate between competing loops.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `planning_horizon` | 10 | Maximum number of sub-goals to plan ahead |
| `replanning_threshold` | 0.3 | Deviation fraction (0–1) above which replanning is triggered |
| `risk_tolerance` | 0.2 | Maximum acceptable risk score for a plan to be selected |
| `deadline` | 60s | Maximum time budget for plan computation |
| `exploration_budget` | 0.1 | Fraction of compute budget allocated to RL exploration |
| `parallelism_limit` | 3 | Maximum number of sub-goals planned in parallel |

## Example

**Task**: A mobile manipulator robot must navigate from point A (charging
station) to point B (workbench), avoid obstacles, and pick up a specific tool
from the bench.

1. **goal**: Meta-control sends "retrieve the torque wrench from the workbench."
2. **decompose**: Planning breaks this into sub-goals:
   - `navigate_to(workbench)`
   - `locate(torque_wrench)`
   - `grasp(torque_wrench)`
   - `verify_grasp()`
3. **plan**: Using the FSM template, planning builds a state graph:
   `NAVIGATE → LOCATE → APPROACH → GRASP → VERIFY`. For `NAVIGATE`, it runs
   A* over the known map, producing waypoints that avoid static obstacles. For
   `GRASP`, it uses the predictor template to simulate 5 candidate grasp poses
   and selects the one with the highest predicted success probability.
4. **execute**: Planning dispatches the waypoint sequence to sensorimotor.
   Sensorimotor begins navigating while planning monitors progress.
5. **monitor**: At waypoint 3 of 7, sensorimotor reports an unexpected obstacle
   (a person walking across the path). The deviation exceeds the
   `replanning_threshold` of 0.3.
6. **replan**: Planning recomputes a new path from the current position to the
   workbench, this time routing around the detected obstacle. The updated
   waypoint sequence is dispatched to sensorimotor, which resumes execution.

Throughout, planning reports status to meta-control, streams deviation data to
error-correction, and logs the successful plan to memory for future retrieval.
