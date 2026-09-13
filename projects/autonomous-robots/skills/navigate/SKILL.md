---
name: navigate
description: >
  The navigate skill moves a robot from its current position to a target while
  avoiding obstacles. It performs path planning, obstacle avoidance, localization,
  and trajectory following. Trigger keywords: navigation, path following, waypoint
  following, maze solving, route planning, obstacle avoidance, localization, SLAM,
  waypoint tracking.
---

# Navigate Skill

## Purpose

Move from the current position to a target location while avoiding obstacles.
The navigate skill is the **locomotion layer** invoked by the planning loop when
spatial displacement is required. It takes a goal coordinate, consults the map,
senses the immediate environment, and produces a sequence of velocity and steering
commands that carry the robot to its destination safely.

## Inputs

- **Target coordinates** from `planning` — the goal pose (x, y, θ) the robot
  must reach, typically delivered as a waypoint in the robot's coordinate frame.
- **Map data** from `memory` — the current occupancy grid, known static
  obstacles, and previously traversed paths. May be a metric map (SLAM) or a
  topological graph of waypoints.
- **Sensor data** from `sensorimotor` — real-time readings from LiDAR, cameras,
  IMU, and wheel encoders that reflect the current state of the environment and
  the robot's pose within it.

## Processing

Each navigate cycle performs four stages:

1. **Localize** — estimate the robot's current pose by fusing sensor data with
   the map (e.g., Monte Carlo localization, AMCL, or visual-inertial odometry).
   Correct for drift and update the map if new obstacles are detected.
2. **Plan** — compute a collision-free path from the current pose to the target
   using the map and current sensor data. Algorithms may include A*, D*,
   RRT*, or potential fields depending on the template selected.
3. **Avoid** — check the planned trajectory against real-time sensor readings.
   If a dynamic obstacle is detected on the path, compute a local detour or
   apply reactive avoidance (e.g., artificial potential fields, velocity
   obstacles).
4. **Follow** — convert the planned path into velocity and steering commands
   using a trajectory-tracking controller (e.g., pure pursuit, PID, or model
   predictive control).

## Outputs

- **Velocity commands** — linear and angular velocity setpoints sent to the
  sensorimotor loop for actuator execution.
- **Steering commands** — heading adjustments for differential-drive or
  Ackermann-steering platforms.
- **Waypoint updates** — progress reports on which waypoint the robot has
  reached, sent back to `planning` so it can advance the task graph.

## Loop Cycle

```
sense → localize → plan → act → check → repeat
```

| Stage | Description |
|-------|-------------|
| **sense** | Read LiDAR, camera, IMU, and encoder data from sensorimotor. |
| **localize** | Fuse sensor data with the map to estimate current pose. |
| **plan** | Compute a collision-free path to the target using the selected template. |
| **act** | Generate velocity and steering commands for the trajectory tracker. |
| **check** | Verify the robot is on track; detect deviation or new obstacles. |
| **repeat** | If not at goal, continue the cycle; if at goal, signal completion. |

## Templates

The navigate skill selects a template based on the environment structure and
task requirements:

| Template | Use Case | Characteristics |
|----------|----------|-----------------|
| **FSM** (`fsm-template`) | Discrete navigation states | State machine with explicit transitions (e.g., `EXPLORE → FOLLOW_WALL → AT_GOAL → DONE`). Best for structured environments with clear behavioral modes like maze solving. |
| **CPG** (`cpg-template`) | Rhythmic locomotion | Central pattern generator producing stable limit cycles for legged walking or continuous steering. Best for platforms where smooth, rhythmic motion is needed. |
| **Predictor** (`predictor-template`) | Trajectory prediction | Uses a dynamics model to predict the sensory outcome of candidate velocity commands before executing. Selects the command whose predicted outcome best matches the goal. Supports multi-step lookahead. |

## Integration

The navigate skill is invoked by the **planning loop** and connects to the
broader framework as follows:

- **Sensorimotor** (downstream): Sends velocity and steering commands for
  actuator execution. Receives real-time sensor data (LiDAR, IMU, encoders)
  and reports execution status (on-track, deviated, obstacle detected).
- **Planning** (upstream): Receives target waypoints and reports progress
  (waypoint reached, goal achieved, path blocked). When navigate detects a
  persistent obstacle or localization failure, it signals planning to
  re-plan with updated constraints.
- **Memory** (sideways): Reads the current map and writes updated map data
  when new obstacles are discovered. Retrieves historical path costs and
  learned navigation policies for similar environments.
- **Error-correction** (sideways): Reports deviations from the planned
  trajectory, localization failures, and recovery attempts. When navigate
  exhausts its recovery attempts, it hands control to error-correction for
  anomaly diagnosis and higher-level recovery strategies.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `target_tolerance` | 0.05 m | Distance within which the robot is considered to have reached the target. |
| `obstacle_distance` | 0.3 m | Minimum safe distance to maintain from detected obstacles. |
| `max_speed` | 1.0 m/s | Maximum linear velocity command. |
| `planning_horizon` | 5.0 m | Distance ahead of the robot to plan the trajectory. |
| `recovery_attempts` | 3 | Number of recovery behaviors to try before escalating to error-correction. |

## Example

**Task**: A mobile robot must navigate a maze using wall-following to reach a
red ball placed at the center.

1. **sense**: LiDAR returns 2D range scans at 10 Hz; IMU reports orientation;
   wheel encoders track distance traveled.
2. **localize**: The robot has no prior map, so it builds one online via SLAM.
   Its current pose is estimated by correlating LiDAR scans with the growing
   occupancy grid.
3. **plan**: Using the FSM template, the robot enters the `FOLLOW_WALL` state.
   The wall-following policy keeps the left wall at a distance of 0.3 m by
   adjusting angular velocity. When the wall ends (dead end), it transitions
   to `TURN` to follow the next wall.
4. **act**: Velocity commands are sent to the sensorimotor loop: linear
   velocity 0.2 m/s, angular velocity adjusted to maintain wall distance.
5. **check**: The robot's camera detects a red object ahead. It transitions
   from `FOLLOW_WALL` to `APPROACH_TARGET`, switching to a direct path to
   the ball's coordinates.
6. **repeat**: The cycle continues until the robot is within `target_tolerance`
   of the ball. The FSM transitions to `AT_GOAL` and signals completion to
   planning.

Throughout, the robot updates its map in memory, reports waypoint progress to
planning, and streams sensor data to sensorimotor for continuous feedback.
