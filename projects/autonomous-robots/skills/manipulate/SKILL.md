---
name: manipulate
description: >
  The manipulate skill handles object manipulation — reaching, grasping, lifting,
  moving, and placing objects in the environment. It performs trajectory
  generation for the arm, force control for the gripper, and compliance
  management during contact. Trigger keywords: manipulation, grasping, object
  manipulation, arm control, gripper control, dexterous manipulation,
  pick-and-place, object interaction, tool use, force control.
---

# Manipulate Skill

## Purpose

Manipulate objects in the environment — reach for, grasp, lift, move, and place
objects with controlled force and precision. The manipulate skill is the
**dexterous interaction layer** invoked by the planning loop when physical
object interaction is required. It takes a target object and desired pose,
consults the current scene understanding, and produces a sequence of joint and
gripper commands that carry out the manipulation safely and reliably.

## Inputs

- **Target object** from `planning` — the object to manipulate, identified by
  its semantic label, 3D pose, and geometric properties (shape, size, mass).
- **Goal pose** from `planning` — the desired final position and orientation
  of the object (or the robot's end-effector) after manipulation.
- **Force feedback** from `sensorimotor` — real-time tactile, force/torque, and
  proprioceptive readings that reflect the current interaction forces between
  the robot and the object.

## Processing

Each manipulate cycle performs five stages:

1. **Reach** — compute a collision-free trajectory from the robot's current
   end-effector pose to a pre-grasp pose near the target object. Use inverse
   kinematics and trajectory optimization to generate smooth joint-space
   commands.
2. **Grasp** — select a grasp pose on the object based on its geometry and
   the task requirements. Close the gripper with controlled force, monitoring
   tactile feedback for contact and slip.
3. **Lift** — raise the object to a safe height, verifying that the grasp is
   secure by checking force/torque readings and object stability.
4. **Move** — transport the object along a collision-free path to the goal
   pose, maintaining grasp stability and avoiding obstacles.
5. **Place** — release the object at the goal pose with controlled force,
   verifying final placement accuracy.

## Outputs

- **Joint commands** — position, velocity, or torque setpoints for each arm
  joint, sent to the sensorimotor loop for actuator execution.
- **Gripper commands** — open/close commands and force limits for the gripper,
  sent to the sensorimotor loop for actuator execution.
- **Force commands** — impedance or admittance control parameters that
  determine how the arm responds to external forces during contact.

## Loop Cycle

```
sense → plan → reach → grasp → lift → place → verify
```

| Stage | Description |
|-------|-------------|
| **sense** | Read current joint angles, object pose, and force feedback from sensorimotor. |
| **plan** | Compute pre-grasp, grasp, lift, and place trajectories using the selected template. |
| **reach** | Execute the pre-grasp trajectory to position the end-effector near the object. |
| **grasp** | Close the gripper with controlled force; monitor tactile feedback for contact. |
| **lift** | Raise the object to a safe height; verify grasp stability via force/torque. |
| **place** | Move to the goal pose and release the object with controlled force. |
| **verify** | Check final object placement; report success or failure to planning. |

## Templates

The manipulate skill selects a template based on the structure of the
manipulation task:

| Template | Use Case | Characteristics |
|----------|----------|-----------------|
| **FSM** (`fsm-template`) | Discrete manipulation states | State machine with explicit transitions (`IDLE → REACH → GRASP → LIFT → MOVE → PLACE → VERIFY`). Best for structured pick-and-place tasks with well-defined stages. |
| **CPG** (`cpg-template`) | Rhythmic manipulation | Central pattern generator producing periodic oscillatory motion for rhythmic manipulation tasks (e.g., screwing, stirring, polishing). Best for continuous, repetitive manipulation. |
| **RL** (`rl-template`) | Adaptive grasping | Reinforcement learning agent that learns optimal grasp poses and grip forces through trial and reward. Best for novel objects or uncertain environments where analytical grasp planning is unreliable. |

## Integration

The manipulate skill is invoked by the **planning loop** and connects to the
broader framework as follows:

- **Sensorimotor** (downstream): Sends joint and gripper commands for actuator
  execution. Receives real-time force/torque, tactile, and proprioceptive data.
  Reports execution status (on-track, force limit exceeded, grasp failed).
- **Planning** (upstream): Receives target object, goal pose, and task
  constraints. Reports manipulation progress (stage completed, grasp success,
  placement verified). When manipulation fails, signals planning to re-plan
  with alternative strategies.
- **Learning** (feedback): Streams (state, action, outcome) tuples from
  manipulation attempts for policy improvement. Receives updated grasp policies
  and force control parameters from the RL template.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `grasp_force` | 10.0 N | Target grip force for grasping objects. Adjusted based on object fragility. |
| `reach_tolerance` | 0.01 m | Maximum distance between the end-effector and the target pre-grasp pose. |
| `lift_height` | 0.1 m | Safe height above the current surface to lift objects before transport. |
| `placement_accuracy` | 0.005 m | Maximum allowable deviation from the goal pose after placement. |

## Example

**Task**: A robot arm must pick up a red ball from a maze and place it at a
designated target location.

1. **sense**: The arm's joint angles are read from encoders; the red ball's
   pose is detected by the camera and segmented from the maze background.
   Force/torque sensors report zero contact force.
2. **plan**: Using the FSM template, the skill enters the `REACH` state. A
   collision-free trajectory is computed from the arm's current pose to a
   pre-grasp pose 5 cm above the ball.
3. **reach**: Joint commands are sent to the sensorimotor loop. The arm moves
   smoothly to the pre-grasp pose, avoiding maze walls.
4. **grasp**: The skill transitions to `GRASP`. The gripper closes with a
   target force of 5 N (the ball is lightweight). Tactile sensors confirm
   contact on both fingers. Force/torque readings show the ball is secure.
5. **lift**: The skill transitions to `LIFT`. The arm raises the ball 10 cm
   above the maze surface. Force feedback confirms the ball has not slipped.
6. **move**: The skill transitions to `MOVE`. A collision-free path is
   computed to the target location, navigating around maze walls. The arm
   transports the ball along the path.
7. **place**: The skill transitions to `PLACE`. The arm lowers the ball to the
   target location and releases it with a controlled force of 2 N.
8. **verify**: The skill transitions to `VERIFY`. The camera confirms the ball
   is at the target location within `placement_accuracy` (5 mm). The skill
   signals success to planning and returns to `IDLE`.

Throughout, the manipulate skill streams grasp attempt data to the learning
loop, which uses the RL template to improve future grasp policies for similar
objects.
