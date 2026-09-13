---
name: error-correction
description: >
  The error-correction loop handles deviation detection and recovery. It compares
  expected outcomes from planning against actual outcomes from sensorimotor, detects
  anomalies and failures, performs root-cause analysis, selects and executes
  correction strategies, and verifies recovery. Trigger keywords: error correction,
  deviation detection, recovery, fault tolerance, anomaly detection, dead-end
  recovery, exception handling, robustness, self-repair.
---

# Error-Correction Loop

## Purpose

The error-correction loop is the **robustness layer** of the autonomous robotics
framework. Where sensorimotor reacts to the present and planning anticipates the
future, error-correction ensures that when reality diverges from expectation, the
robot detects the deviation, diagnoses its cause, and recovers gracefully. It is
the safety net that prevents cascading failures and enables the robot to continue
operating in the face of uncertainty, model drift, and unexpected events.

The core cycle is: **predict → compare → detect → diagnose → correct → verify**.

## Inputs

- **Expected outcomes** from `planning` — the predicted state trajectory, planned
  waypoints, and expected sensor readings at each step of the current plan.
- **Actual outcomes** from `sensorimotor` — the real-time perceptual state,
  actuator feedback, and observed consequences of executed actions.
- **Error signals** from `learning` — anomaly classifications, prediction error
  magnitudes, and confidence scores from learned models that flag uncertain or
  surprising situations.
- **Memory of past failures** from `memory` — historical records of similar
  anomalies, the recovery actions that succeeded or failed, and root-cause
  attributions for recurring failure patterns.

## Processing

Each error-correction cycle performs five stages:

1. **Prediction** — establish the expected state at the current point in the plan.
   This may be a predicted sensor reading, a planned waypoint, or a projected
   outcome from the planning loop's trajectory model.
2. **Comparison** — measure the actual state from sensorimotor against the
   predicted state. Compute a deviation metric (e.g., Euclidean distance in
   state space, classification mismatch, or prediction error magnitude).
3. **Error detection** — determine whether the deviation exceeds the configured
   error threshold. If it does, classify the anomaly type (e.g., obstacle
   encountered, actuator saturation, model drift, sensor failure) using the
   learning loop's anomaly classifier.
4. **Root cause analysis** — trace the deviation back to its likely source. Was it
   an environmental change (unmapped obstacle), a planning failure (infeasible
   trajectory), a sensorimotor issue (actuator saturation), or a model limitation
   (outdated cost model)? Consult memory for similar past failures and their
   attributed causes.
5. **Correction strategy selection** — choose a recovery action based on the
   anomaly type and root cause. Options include local repair (adjust the current
   action), replanning (request a new plan from the planning loop), or escalation
   (report to meta-control for loop re-sequencing).

## Outputs

- **Correction commands** — immediate adjustments to sensorimotor's current
  action (e.g., reduce speed, reorient, abort grasp) to stabilize the situation.
- **Replanning requests** — signals to the planning loop to recompute the
  affected trajectory segment or generate a new plan from the current state.
- **Learning signals** — anomaly classifications, recovery outcomes, and
  root-cause attributions sent to the learning loop as negative reward signals
  and training data for improved anomaly detection.
- **Memory updates** — failure patterns, recovery actions taken, and their
  outcomes stored in memory for future recall when similar anomalies occur.

## Loop Cycle

```
predict → compare → detect → diagnose → correct → verify
```

| Stage | Description |
|-------|-------------|
| **predict** | Establish the expected state or outcome from the current plan. |
| **compare** | Measure the actual state from sensorimotor against the prediction. |
| **detect** | Determine whether the deviation exceeds the error threshold; classify the anomaly. |
| **diagnose** | Trace the deviation to its root cause using memory of past failures. |
| **correct** | Select and execute a recovery strategy — local repair, replanning, or escalation. |
| **verify** | Confirm that the correction resolved the deviation; if not, escalate or retry. |

## Templates

The error-correction loop selects a template based on the nature of the anomaly
and the recovery strategy required:

| Template | Use Case | Characteristics |
|----------|----------|-----------------|
| **FSM** (`fsm-template`) | Error state handling | Manages recovery through discrete states: `NORMAL → ANOMALY_DETECTED → DIAGNOSING → CORRECTING → VERIFYING → RECOVERY_COMPLETE` (or `ESCALATE`). Each state maps to a fixed recovery policy. Best for well-understood failure modes with clear recovery procedures. |
| **Predictor** (`predictor-template`) | Anomaly detection | Uses a learned or analytical model to predict the expected sensorimotor state at each step. Deviations between prediction and observation are flagged as anomalies. The model is continuously updated by the learning loop. Best for detecting subtle or novel deviations. |
| **RL** (`rl-template`) | Recovery policy learning | Learns a recovery policy through trial and reward — actions that reduce deviation and restore plan progress are reinforced. The policy adapts to environmental changes and novel failure modes over time. Best for complex, uncertain environments where recovery procedures are not pre-specified. |

## Integration

The error-correction loop is a **sideways layer** that monitors all other loops
and intervenes when deviations are detected:

- **Meta-control** (upstream): Reports critical failures that cannot be resolved
  locally — persistent anomalies, repeated recovery failures, or safety violations.
  When error-correction escalates, meta-control may re-sequence loops, switch
  templates, or request human intervention. Meta-control also receives periodic
  health summaries for overall system status reporting.
- **Sensorimotor** (downstream): Sends correction commands to adjust ongoing
  actions (e.g., slow down, reorient, abort). Receives real-time state updates
  for continuous comparison against predictions. When error-correction pauses
  actuation during diagnosis, sensorimotor holds its current state until a
  correction is issued.
- **Planning** (sideways): Receives replanning requests when the current plan
  is no longer feasible. Planning reports expected outcomes and trajectory
  predictions for comparison. When error-correction detects a deviation, it
  signals planning to recompute the affected segment or generate a new plan
  from the current state.
- **Learning** (sideways): Receives anomaly classifications, recovery outcomes,
  and root-cause attributions as negative reward signals and training data.
  Learning provides updated anomaly classifiers and confidence scores that
  improve error-correction's detection accuracy over time.
- **Memory** (sideways): Stores failure patterns, recovery actions, and their
  outcomes for future recall. When error-correction encounters a known anomaly
  type, memory retrieves the previously successful recovery action. Memory also
  provides historical context for root cause analysis.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `error_threshold` | 0.15 | Maximum deviation (normalized 0–1) between predicted and actual state before an anomaly is flagged |
| `correction_timeout` | 5.0s | Maximum time to attempt a correction before escalating to meta-control |
| `retry_limit` | 3 | Maximum number of correction attempts before escalating |
| `anomaly_sensitivity` | 0.8 | Threshold for the anomaly classifier's confidence score to trigger error-correction (higher = fewer false positives) |
| `recovery_budget` | 0.2 | Fraction of total task time budget allocated to recovery operations |

## Example

**Task**: A mobile robot is navigating through a maze using a planned waypoint
sequence. At waypoint 4 of 7, the robot's LiDAR detects an obstacle directly
ahead that was not present in the map.

1. **predict**: Error-correction expects the robot to be at waypoint 4
   coordinates (2.3, 1.8) with a clear path to waypoint 5. The planning loop's
   trajectory model predicts a straight-line path with no obstacles.
2. **compare**: Sensorimotor reports the actual state — the robot is at (2.28,
   1.79), close to the predicted position, but LiDAR shows an obstacle at 0.4 m
   ahead, directly on the planned path. The deviation in position is small
   (0.02 m), but the obstacle creates a large deviation in expected traversability.
3. **detect**: The deviation in traversability exceeds the `error_threshold` of
   0.15. The learning loop's anomaly classifier (predictor template) classifies
   this as an "unexpected obstacle" with 0.92 confidence, above the
   `anomaly_sensitivity` of 0.8.
4. **diagnose**: Error-correction consults memory for similar failures. Memory
   retrieves a past experience: "unexpected obstacle at corridor junction —
   recovery: re-plan around obstacle using local detour." The root cause is
   classified as an environmental change (unmapped obstacle), not a planning or
   sensorimotor failure.
5. **correct**: Error-correction selects the FSM template's recovery state
   `CORRECTING`. It sends a correction command to sensorimotor: "stop forward
   motion, rotate 30° left, scan for clearance." Simultaneously, it sends a
   replanning request to planning: "recompute path from current position to
   waypoint 5, avoiding the detected obstacle."
6. **verify**: After the correction, sensorimotor reports the robot has rotated
   and the path to the left is clear. Planning confirms a new feasible trajectory.
   Error-correction verifies the deviation is resolved — the robot is now on a
   new path that avoids the obstacle. The FSM transitions to
   `RECOVERY_COMPLETE` and resumes normal monitoring.

The robot continues to the goal, arriving 12 seconds later than originally
planned. The failure pattern and successful recovery are stored in memory, and
the anomaly classifier is updated with this new experience.
