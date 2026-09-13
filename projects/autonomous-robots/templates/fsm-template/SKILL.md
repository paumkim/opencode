---
name: fsm-template
description: >
  A reusable finite state machine template for loop and skill implementations.
  Provides a standard set of states, transition rules, and error-handling
  patterns that can be applied to any discrete, event-driven control task.
  Trigger keywords: finite state machine, state machine, FSM, state-based
  control, state transition, mode switching, discrete states, state chart.
---

# FSM Template

## Purpose

Provide a reusable finite state machine (FSM) template for implementing
discrete, event-driven control logic in loops and skills. The FSM template
encapsulates the standard pattern of **state → event → transition → action**
that appears across robotics tasks: navigation mode switching, task
sequencing, recovery behaviors, and error handling.

An FSM is appropriate when the task can be decomposed into a finite set of
distinct behavioral modes, each with well-defined entry/exit conditions and
transitions triggered by events or sensor thresholds.

## States

The template defines six standard states that cover the lifecycle of any
discrete control task:

| State | Description |
|-------|-------------|
| **idle** | Waiting for a start signal or trigger. No actuators are active. |
| **sensing** | Reading and processing sensor data to determine the current situation. |
| **processing** | Analyzing sensed data, evaluating conditions, and deciding the next action. |
| **acting** | Executing the selected action (motor command, trajectory, etc.). |
| **error** | An anomaly or failure condition has been detected. Actuation is paused. |
| **recovery** | Attempting to recover from the error condition (re-localize, re-plan, retry). |

Not every task uses all six states. A simple task may use only `idle → acting →
idle`. A complex task may cycle through `sensing → processing → acting` repeatedly
with `error → recovery` branches.

## Transitions

Transitions are triggered by **events** (external signals) or **conditions**
(internal thresholds). Each transition has a guard (the condition that must be
true) and an action (what happens on entry to the new state).

```
idle ──(start_signal)──► sensing
sensing ──(data_ready)──► processing
processing ──(action_selected)──► acting
acting ──(action_complete)──► sensing
acting ──(goal_reached)──► idle
sensing ──(anomaly_detected)──► error
processing ──(condition_failed)──► error
acting ──(deviation_exceeds_threshold)──► error
error ──(recovery_available)──► recovery
recovery ──(recovery_success)──► sensing
recovery ──(recovery_failed)──► error
error ──(unrecoverable)──► idle
```

**Transition rules:**

1. **Guards are evaluated every cycle** — a transition fires only when its guard
   condition is met.
2. **Entry actions** run immediately upon entering a state (e.g., on entering
   `acting`, send the motor command).
3. **Exit actions** run when leaving a state (e.g., on leaving `acting`, stop
   the motors).
4. **Timeouts** — if a state persists beyond `state_timeout`, an implicit
   `timeout` event fires, typically triggering a transition to `error`.
5. **Priority** — `error` and `recovery` transitions take priority over normal
   flow transitions.

## Usage

To apply this template to a loop or skill:

1. **Identify the behavioral modes** — decompose the task into discrete states.
   Map them to the standard states where possible; add custom states only if
   the standard set is insufficient.
2. **Define transition guards** — for each pair of states, specify the event or
   condition that triggers the transition. Use sensor thresholds, timer
   expirations, or external signals.
3. **Implement entry/exit actions** — specify what happens when entering or
   leaving each state (e.g., send a command, reset a counter, log an event).
4. **Wire to the loop cycle** — the FSM runs inside the loop's cycle. Each
   iteration: read sensors → evaluate current state's guard conditions →
   transition if needed → execute entry/exit actions → produce output.
5. **Connect to error-correction** — when the FSM enters `error` or exhausts
   `recovery` attempts, signal the error-correction loop for diagnosis.

The FSM template is instantiated by the loop or skill that needs it. The loop
provides the sensor data and actuator interface; the FSM provides the state
logic. The loop calls `fsm.update(event)` each cycle and acts on the returned
state and action.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `state_timeout` | 30 s | Maximum time allowed in any single state before a timeout event fires. |
| `transition_conditions` | — | Map of state-pair → guard condition (e.g., `sensing→processing: data_ready`). |
| `error_handling` | escalate | Behavior on unrecoverable error: `escalate` (signal error-correction), `retry` (restart from idle), or `halt` (stop all actuation). |
| `recovery_attempts` | 3 | Maximum number of recovery cycles before escalating to error-correction. |
| `recovery_timeout` | 10 s | Maximum time allowed in the `recovery` state per attempt. |

## Example

**Applying the FSM template to the navigate skill** — a robot navigating a maze
using wall-following to reach a red ball.

The navigate skill uses a custom state set derived from the standard template:

```
idle ──(goal_received)──► exploring
exploring ──(wall_detected)──► following_wall
following_wall ──(target_in_sight)──► approaching_target
following_wall ──(goal_reached)──► at_goal
approaching_target ──(target_reached)──► at_goal
at_goal ──(task_complete)──► done
exploring ──(anomaly)──► error
following_wall ──(anomaly)──► error
error ──(recovery_available)──► recovery
recovery ──(recovery_success)──► exploring
recovery ──(recovery_failed)──► done
```

**State behaviors:**

- **exploring**: Move forward at low speed, scanning for walls with LiDAR.
- **following_wall**: Maintain a fixed distance from the left wall using
  proportional control on angular velocity.
- **approaching_target**: Switch to direct path-to-goal navigation using the
  target's coordinates.
- **at_goal**: Stop all motion, signal completion to planning.
- **error**: Halt actuation, report anomaly to error-correction.
- **recovery**: Attempt re-localization via scan-matching; if successful,
  return to `exploring`; if failed after 3 attempts, signal `done` with
  failure status.

**Transition guards:**

- `exploring → following_wall`: LiDAR detects a wall within 0.5 m on the left.
- `following_wall → approaching_target`: Camera detects a red object within
  2 m and centered in the field of view.
- `following_wall → at_goal`: Distance to goal < `target_tolerance` (0.05 m).
- `approaching_target → at_goal`: Target coordinates reached within tolerance.
- `any → error`: Localization uncertainty exceeds threshold, or sensor data
  is missing for more than 2 consecutive cycles.
- `error → recovery`: Error-correction provides a recovery action (re-localize,
  re-plan, or reset).
- `recovery → exploring`: Recovery action completed successfully.
- `recovery → done`: Recovery attempts exhausted (3 failures).

This FSM runs inside the navigate skill's loop cycle: each iteration reads
sensors, evaluates the current state's guard conditions, transitions if
needed, and executes the entry/exit actions for the new state.
