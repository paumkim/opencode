---
name: homeostasis
description: >
  The homeostasis loop handles internal state regulation for the robot. It
  continuously monitors vital signs — battery level, temperature, CPU usage,
  motor current — compares them against setpoints and safety margins, detects
  deviations, prioritizes which needs attention first, selects and executes
  corrective actions (power-saving, cooling, maintenance), and verifies the
  response. Trigger keywords: homeostasis, internal state, battery, power
  management, thermal regulation, resource monitoring, energy budget,
  self-maintenance, vital signs, health monitoring.
---

# Homeostasis Loop

## Purpose

The homeostasis loop is the **internal regulation layer** of the autonomous
robotics framework. While sensorimotor reacts to the external world and planning
anticipates future goals, homeostasis ensures the robot's own physical and
computational systems remain within safe, sustainable operating ranges. It is
the robot's autonomic nervous system: always running, always watching, and
always ready to intervene when a vital sign drifts toward danger.

The core cycle is: **monitor → assess → prioritize → act → verify → adapt**.

## Inputs

- **Battery level** from `sensorimotor` — voltage, current draw, state of charge,
  and discharge rate. The homeostasis loop uses these to estimate remaining
  operational time and detect abnormal drain patterns.
- **Temperature** from `sensorimotor` — motor windings, CPU/GPU die, battery
  pack, ambient environment, and critical components. Thermal readings are
  timestamped and fused with motion context to distinguish normal heating from
  dangerous overheating.
- **CPU usage** from `sensorimotor` — processor load, memory pressure, and
  thermal throttling status. High CPU usage may indicate computational overload
  or a runaway process that threatens real-time control deadlines.
- **Motor current** from `sensorimotor` — per-joint current draw, stall
  detection, and torque estimates. Abnormal current spikes indicate mechanical
  binding, excessive friction, or impending actuator failure.
- **Task urgency** from `planning` — the criticality and deadline of the current
  mission. A life-critical task (e.g., emergency response) raises the tolerance
  for resource depletion; a routine task (e.g., shelf restocking) lowers it,
  making the robot more willing to defer work for self-maintenance.

## Processing

Each homeostasis cycle performs five stages:

1. **State monitoring** — read all vital signs from sensorimotor at the
   configured `monitor_rate`. Each reading is timestamped, validated against
   expected ranges, and stored in a rolling window for trend analysis.
2. **Deviation detection** — compare each vital sign against its setpoint and
   safety margins. A deviation is flagged when a reading crosses a warning
   threshold (e.g., battery below 20%) or when a trend predicts a critical
   threshold will be crossed within the prediction horizon (e.g., temperature
   rising at 5°C/s, projected to exceed 80°C in 3 seconds).
3. **Priority assessment** — rank all flagged deviations by urgency. Priority is
   computed from the severity of the deviation, the rate of change, the
   predicted time to critical, and the task urgency from planning. A rapidly
   overheating motor during a non-critical task ranks lower than a slowly
   draining battery during a life-critical mission.
4. **Corrective action selection** — for the highest-priority deviation, select
   the appropriate response from the action catalog: power-saving (throttle
   non-essential systems), cooling (activate fans, reduce motor output),
   maintenance (request inspection, log anomaly), or task deferral (signal
   planning to pause non-critical work).
5. **Execution** — dispatch the selected action. Power-saving and cooling
   commands go to sensorimotor for actuator-level execution. Maintenance
   requests and task deferral signals go to meta-control for arbitration.

## Outputs

- **Power-saving commands** — directives to sensorimotor to reduce actuator
  output, dim LEDs, lower sensor sampling rates, or enter low-power idle.
- **Cooling commands** — directives to sensorimotor to activate fans, reduce
  motor torque, or pause high-CPU operations until thermal conditions improve.
- **Maintenance requests** — structured alerts sent to meta-control indicating
  that a component requires inspection, calibration, or replacement. Includes
  the affected component, severity level, and recommended action.
- **Task deferral signals** — interrupts sent to planning (via meta-control)
  requesting that non-critical tasks be paused or rescheduled. Includes the
  reason (e.g., "battery critical, charging required") and estimated recovery
  time.

## Loop Cycle

```
monitor → assess → prioritize → act → verify → adapt
```

| Stage | Description |
|-------|-------------|
| **monitor** | Read all vital signs (battery, temperature, CPU, motor current) from sensorimotor. |
| **assess** | Compare readings against setpoints and safety margins; flag deviations. |
| **prioritize** | Rank flagged deviations by severity, rate of change, and task urgency. |
| **act** | Select and dispatch the appropriate corrective action (power, cooling, maintenance, deferral). |
| **verify** | Confirm the action had the intended effect; readings should trend toward setpoint. |
| **adapt** | Update setpoints and response policies based on observed effectiveness. |

## Templates

The homeostasis loop selects a template based on the structure of the regulation
problem and the available models:

| Template | Use Case | Characteristics |
|----------|----------|-----------------|
| **FSM** (`fsm-template`) | State-based regulation | Manages the lifecycle of a vital sign through discrete states: `NOMINAL → WARNING → CRITICAL → RECOVERING → NOMINAL`. Transitions are triggered by threshold crossings and timeout events. Best for well-structured regulation tasks with clear state transitions and deterministic responses. |
| **Predictor** (`predictor-template`) | Resource depletion prediction | Uses a learned or analytical model to predict future vital sign values based on current trends and task context. Estimates time-to-critical for each resource and pre-emptively triggers corrective action before a threshold is crossed. Best for proactive regulation where early intervention prevents emergencies. |
| **RL** (`rl-template`) | Adaptive setpoints | Learns optimal setpoints and response policies through trial and reward. The policy is rewarded for maintaining vital signs within safe ranges while minimizing unnecessary interventions that disrupt task execution. Best for environments where optimal trade-offs between performance and safety are difficult to specify analytically. |

## Integration

The homeostasis loop is a **parallel layer** that runs continuously alongside
all other loops:

- **Meta-control** (upstream): Reports critical states that may require
  mission-level re-sequencing. When a vital sign crosses the `critical_threshold`,
  the homeostasis loop sends an interrupt to meta-control, which may suspend the
  current mission and re-sequence loops (e.g., prioritize charging over task
  completion). Meta-control also receives maintenance requests for logging and
  scheduling.
- **Sensorimotor** (downstream): Receives power-saving and cooling commands
  for actuator-level execution. Sensorimotor streams raw vital sign readings
  (battery voltage, motor temperature, CPU load, joint current) to homeostasis
  at the configured `monitor_rate`. When homeostasis issues a power-saving
  command, sensorimotor adjusts actuator output and sensor sampling rates
  accordingly.
- **Planning** (sideways): Receives task deferral signals when non-critical
  tasks must be paused for self-maintenance. Planning provides task urgency and
  deadline context to bias priority assessment — a life-critical mission raises
  the tolerance for resource depletion, while a routine task lowers it.
- **Attention** (sideways): Receives threat-level signals when a vital sign
  crosses the `attention_threshold`, biasing the attention loop to prioritize
  self-relevant stimuli (e.g., charging stations, cooling vents).
- **Resource** (sideways): Coordinates on compute and power allocation. When
  homeostasis triggers power-saving mode, resource reduces the compute budget
  allocated to non-essential loops. Resource also provides system-wide power
  and compute budgets that inform homeostasis setpoints.
- **Error-correction** (sideways): Receives anomaly reports when a vital sign
  deviates in an unexpected way (e.g., sudden temperature spike with no
  corresponding load increase). Error-correction investigates the root cause
  and may override homeostasis actions if a hardware fault is detected.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `monitor_rate` | 10 Hz | Frequency at which vital signs are read from sensorimotor |
| `battery_warning` | 20% | Battery level below which a warning deviation is flagged |
| `battery_critical` | 10% | Battery level below which a critical deviation is flagged and meta-control is interrupted |
| `temperature_warning` | 70°C | Temperature above which a warning deviation is flagged |
| `temperature_critical` | 85°C | Temperature above which a critical deviation is flagged and cooling is forced |
| `cpu_warning` | 80% | CPU usage above which a warning deviation is flagged |
| `cpu_critical` | 95% | CPU usage above which a critical deviation is flagged and non-essential processes are throttled |
| `motor_current_warning` | 80% | Motor current above which a warning deviation is flagged |
| `motor_current_critical` | 100% | Motor current above which a critical deviation is flagged and actuation is paused |
| `response_urgency` | 0.7 | Minimum priority score (0–1) for a deviation to trigger an immediate corrective action |
| `adaptation_rate` | 0.05 | Learning rate for updating setpoints and response policies based on observed effectiveness |

## Example

**Task**: A mobile robot is exploring an unknown maze to map its layout. During
exploration, the battery level drops to 15% and the motor temperature rises to
78°C.

1. **monitor**: The homeostasis loop reads vital signs from sensorimotor at 10
   Hz. Battery is at 15% (below `battery_warning` of 20%), motor temperature is
   78°C (above `temperature_warning` of 70°C, so this is a warning). CPU usage
   is at 45% (nominal). Motor current is at 60% (nominal).
2. **assess**: Two deviations are flagged: battery at 15% (warning, trending
   down at 2%/min) and motor temperature at 78°C (warning, trending up at
   3°C/min). The predictor template estimates battery will reach critical (10%)
   in 2.5 minutes and temperature will reach critical (85°C) in 2.3 minutes.
3. **prioritize**: Both deviations are urgent, but the temperature is rising
   faster and will cross critical first. However, the task urgency from planning
   is low (routine mapping), so the robot is willing to defer. Priority ranking:
   temperature (0.85) > battery (0.78). The temperature deviation exceeds the
   `response_urgency` of 0.7.
4. **act**: The homeostasis loop selects a cooling action: reduce motor output
   by 20% and activate cooling fans at 80% speed. This command is dispatched to
   sensorimotor. The battery deviation is below `response_urgency` for immediate
   action, so it is logged for the next cycle.
5. **verify**: After 5 seconds, the homeostasis loop re-reads vital signs.
   Motor temperature has dropped to 72°C and is now stable. The cooling action
   was effective. Battery is at 14.5% — still declining but slowly.
6. **adapt**: The adaptation module notes that the cooling response was
   effective and slightly increases the `temperature_warning` setpoint for
   similar load conditions in the future. The battery trend is concerning, so
   the homeostasis loop escalates: it sends a task deferral signal to planning
   and a critical interrupt to meta-control, requesting that the robot return
   to its charging station.

Meta-control receives the critical interrupt and suspends the maze exploration
mission. Planning receives the task deferral signal and pauses the mapping
sub-goals. The robot navigates back to the charging station, plugs in, and
resumes exploration once the battery is restored to 90%.

Throughout, the homeostasis loop continues monitoring at 10 Hz, ensuring that
temperature, CPU, and motor current remain within safe ranges during the
return-to-base maneuver.
