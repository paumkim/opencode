---
name: sensorimotor
description: >
  Design specification for a proposed sensorimotor loop: immediate
  perception-action cycles. It would read raw sensor data (visual, tactile,
  auditory, proprioceptive, environmental), filter and classify it, decide on
  an actuator response, execute the action, and observe the result to adapt the
  next cycle. Not a runnable module. Trigger keywords: sensorimotor,
  perception-action, feedback loop, real-time control, sensor fusion, actuator.
---

# Sensorimotor Loop

## Current Status and Safety Boundary

**Design specification, not a runnable module.** All robot loops currently have
only `SKILL.md`; `src/` is a generic software supervisory runtime. No sensors,
actuators, reflexes, or robot policies below are implemented. There is no hardware
safety certification, actuator enforcement, real-time or latency guarantee,
persistence/resume, or adaptive scheduling.

Physical control would require independent, always-on physical monitoring and
protective controls outside the sequential JS runtime, even when this loop is
inactive or foreground context changes. Optional `AbortSignal` support is
cooperative; ignored cancellation cannot stop actuator activity. Software reset
is not physical clearance. Hardware limits must remain immutable to learning;
adaptive advisory setpoints stay within them. Learned-policy deployment requires
validation, explicit operator approval, and a rollback plan; these gates and
physical protections are requirements, not implemented features.

## Purpose

Proposed **sense → process → act → sense** cycle for low-level perception and
control. Continuous reflex behavior would require a separately validated control
implementation; lifecycle activation here does not create an always-on loop.

## Inputs

Raw sensor data streams, fused into a unified perceptual state:

- **Visual**: camera frames, depth maps, optical flow
- **Tactile**: pressure sensors, force/torque sensors, skin arrays
- **Auditory**: microphone arrays, sound direction, frequency analysis
- **Proprioceptive**: joint angles, motor encoders, IMU (acceleration,
  orientation, angular velocity)
- **Environmental**: proximity sensors, LiDAR, temperature, humidity, light
  levels

## Processing

Each sensorimotor cycle performs four stages:

1. **Filter** — remove noise, calibrate drift, normalize ranges
2. **Detect** — identify salient features (edges, motion, contact events)
3. **Classify** — map features to semantic states (obstacle, graspable,
   slipping, tilted)
4. **Predict** — estimate the immediate consequence of candidate actions
   (short-horizon, 1–3 cycle lookahead)

## Outputs

Actuator commands, bounded by hardware limits:

- **Motor**: velocity/torque commands for continuous rotation
- **Servo**: position commands for articulated joints
- **Gripper**: open/close, force-limited pinch
- **Wheels**: differential or omni-directional drive commands
- **Other**: LED indicators, speaker output, tool actuators

## Loop Cycle

```
sense → filter → decide → act → observe → adapt
```

| Stage | Description |
|-------|-------------|
| **sense** | Read all active sensors, timestamp each reading |
| **filter** | Apply calibration, noise reduction, outlier rejection |
| **decide** | Select action based on current state and active template |
| **act** | Send commands to actuators, respecting safety limits |
| **observe** | Read post-action sensor state, measure effect |
| **adapt** | Update internal model (e.g., prediction error → weight adjustment) |

## Templates

The sensorimotor loop selects a template based on the task structure:

| Template | Use Case | Characteristics |
|----------|----------|-----------------|
| **CPG** (`cpg-template`) | Rhythmic, periodic motion | Central pattern generator; produces stable limit cycles for walking, swimming, waving. No explicit planning — the rhythm emerges from oscillator coupling. |
| **FSM** (`fsm-template`) | Discrete, event-driven states | Finite state machine with explicit transitions (e.g., `IDLE → APPROACH → GRASP → LIFT → RELEASE`). Each state maps to a fixed sensorimotor policy. |
| **Predictor** (`predictor-template`) | Anticipatory control | Uses a learned or analytical model to predict the sensory outcome of actions before executing. Selects the action whose predicted outcome best matches the goal. |

## Integration

The sensorimotor loop is the **bottom layer** of the control hierarchy. It
connects to meta-control as follows:

- **Status reporting**: Continuously reports health metrics (sensor
  availability, actuator saturation, prediction error magnitude) to
  `meta-control.status()`.
- **Attention requests**: When a salient stimulus exceeds a threshold
  (unexpected contact, sudden obstacle, novel sound), the sensorimotor loop
  sends an interrupt to the `attention` loop for further processing.
- **Homeostasis feedback**: Reports battery drain rate, motor temperature,
  and joint wear to the `homeostasis` loop.
- **Error-correction handoff**: If prediction error exceeds a tolerance
  for N consecutive cycles, the loop flags an anomaly and pauses actuation
  until `error-correction` resolves the issue.
- **Learning feedback**: Streams (state, action, outcome) tuples to the
  `learning` loop for offline policy improvement.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `update_rate` | 100 Hz | Sensorimotor cycle frequency |
| `sensor_threshold` | 0.1 | Minimum change in sensor reading to trigger a state transition |
| `actuator_limit` | 0.8 | Maximum actuator output as fraction of rated capacity |
| `prediction_horizon` | 3 | Number of cycles to look ahead in predictor mode |
| `error_tolerance` | 0.05 | Maximum prediction error before anomaly flag |
| `attention_threshold` | 0.9 | Saliency score above which attention is requested |

## Example (Conceptual)

**Task**: A mobile robot must avoid obstacles while navigating to a goal.

1. **sense**: LiDAR returns 360° distance readings at 10 Hz; IMU reports
   orientation; wheel encoders track position.
2. **filter**: LiDAR outliers (spikes from reflective surfaces) are removed
   via median filtering; IMU drift is corrected with a complementary filter.
3. **decide**: An FSM template is active with states `NAVIGATE`, `AVOID_LEFT`,
   `AVOID_RIGHT`. In `NAVIGATE`, the robot moves toward the goal. If any
   LiDAR reading within ±30° of the heading drops below 0.5 m, transition
   to `AVOID_LEFT` or `AVOID_RIGHT` based on which side has more clearance.
4. **act**: In `AVOID_LEFT`, the robot commands a left turn at 0.3 rad/s
   while maintaining forward velocity at 0.2 m/s.
5. **observe**: After 0.5 s, LiDAR confirms the obstacle is cleared;
   transition back to `NAVIGATE`.
6. **adapt**: The prediction model updates its estimate of turning radius
   based on the observed vs. expected trajectory deviation.

Throughout, the loop reports status to meta-control and requests attention
if a novel obstacle pattern is detected.
