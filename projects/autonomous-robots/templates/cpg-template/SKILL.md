---
name: cpg-template
description: >
  A reusable central pattern generator (CPG) template for rhythmic, periodic
  control in loops and skills. Produces stable limit-cycle oscillations through
  coupled oscillators, enabling smooth, self-sustaining periodic motion without
  explicit planning. Trigger keywords: central pattern generator, CPG, rhythmic
  pattern, oscillatory control, gait generation, periodic motion, rhythmic
  locomotion, oscillator, limit cycle.
---

# CPG Template

## Purpose

Provide a reusable central pattern generator (CPG) template for implementing
rhythmic, periodic control in loops and skills. The CPG template encapsulates
the pattern of **coupled oscillators → phase coordination → stable limit cycle
→ periodic output** that appears across robotics tasks: legged gait generation,
swimming undulation, waving gestures, and rhythmic manipulation.

A CPG is appropriate when the task requires smooth, continuous, periodic motion
that should be robust to perturbations and capable of self-sustained rhythm
without step-by-step planning. The oscillators produce stable limit cycles —
trajectories that the system naturally returns to after a disturbance — making
the motion inherently resilient.

## Core Concept

A CPG consists of a network of coupled nonlinear oscillators. Each oscillator
generates a periodic signal (phase, amplitude) and is coupled to its neighbors
so that the collective output forms a coordinated pattern. The coupling
determines the phase relationships between oscillators, which in turn define the
gait or movement pattern.

The key properties of a CPG are:

- **Limit cycle stability** — the oscillator returns to its periodic trajectory
  after a perturbation, without requiring external correction.
- **Phase coordination** — coupling between oscillators ensures that limbs or
  actuators move in the correct sequence and timing.
- **Frequency modulation** — the oscillation frequency can be adjusted in real
  time to speed up or slow down the rhythm.
- **Amplitude control** — the output amplitude can be modulated to change the
  range of motion (e.g., step height, stride length).

## States

The CPG template does not use discrete states in the FSM sense. Instead, it
operates in a continuous phase space:

| State | Description |
|-------|-------------|
| **oscillation phase** | Each oscillator has a phase variable φ ∈ [0, 2π) that advances at a rate determined by the frequency. The phase determines the current position within the oscillation cycle. |
| **amplitude** | The peak deviation of the oscillator output from its resting position. Controls the magnitude of the generated motion. |
| **frequency** | The rate at which the phase advances, measured in Hz. Controls the speed of the rhythmic motion. |
| **coupling** | The interaction strength between oscillators, which determines phase relationships and synchronization. Coupling can be excitatory (in-phase) or inhibitory (anti-phase). |

## Usage

To apply this template to a loop or skill:

1. **Define the oscillator network** — determine how many oscillators are needed
   (one per actuator or limb) and how they are coupled. For a quadruped walking
   gait, four oscillators (one per leg) are coupled so that diagonal legs are
   in-phase and adjacent legs are anti-phase.
2. **Set the phase relationships** — specify the desired phase offset between
   each pair of oscillators. This defines the gait pattern (e.g., trot, pace,
   bound).
3. **Configure frequency and amplitude** — set the base oscillation frequency
   and amplitude for each oscillator. These can be modulated by sensory feedback
   (e.g., increase frequency when the robot is falling behind the desired speed).
4. **Map oscillator output to actuators** — convert the oscillator signals
   (sin/cos of phase × amplitude) into joint torque or position commands.
5. **Add sensory feedback** — close the loop by feeding sensory data (ground
   contact, load, tilt) back into the oscillators to adjust phase, frequency, or
   amplitude in real time. This provides adaptive, perturbation-resistant
   behavior.
6. **Wire to the loop cycle** — the CPG runs inside the loop's cycle. Each
   iteration: read sensors → update oscillator phases → compute actuator
   commands → execute → observe → adapt oscillator parameters.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `frequency` | 1.0 Hz | Base oscillation frequency of each oscillator. Can be modulated by sensory feedback. |
| `amplitude` | 1.0 | Peak output magnitude of each oscillator. Controls the range of motion. |
| `phase_offset` | 0.0 rad | Relative phase offset between coupled oscillators. Defines the gait pattern. |
| `coupling_strength` | 0.5 | Strength of coupling between oscillators. Higher values enforce tighter phase coordination. |
| `damping` | 0.1 | Rate at which the oscillator returns to its limit cycle after a perturbation. Higher damping reduces overshoot. |

## Example

**Applying the CPG template to leg-gait generation for a quadruped robot.**

The quadruped has four legs, each driven by a hip and knee joint. A CPG with
four oscillators (one per leg) is configured:

- **Oscillator network**: Four oscillators, one per leg (front-left,
  front-right, rear-left, rear-right). Each oscillator drives the hip and knee
  joints of its leg via a mapping function.
- **Phase relationships**: For a trot gait, diagonal legs are in-phase (phase
  offset = 0) and adjacent legs are anti-phase (phase offset = π). The phase
  offsets are:
  - Front-left: 0
  - Front-right: π
  - Rear-left: π
  - Rear-right: 0
- **Frequency**: 2.0 Hz — the robot takes two steps per second per leg.
- **Amplitude**: 0.3 rad — the hip joints oscillate through a 0.6 rad range,
  and the knee joints through a 0.4 rad range.
- **Coupling**: Strength 0.8 — strong coupling ensures the diagonal legs stay
  synchronized even on uneven terrain.
- **Damping**: 0.2 — moderate damping allows quick recovery from perturbations
  (e.g., stepping on a rock) without excessive oscillation.

**Sensory feedback**: Ground-contact sensors on each foot feed back into the
oscillators. When a foot touches down, the corresponding oscillator's phase is
advanced slightly to ensure the next step begins at the right time. If the
robot tilts forward, the rear oscillators increase their frequency to catch up.

**Loop integration**: The CPG runs at 100 Hz inside the sensorimotor loop.
Each cycle: read ground-contact sensors → advance oscillator phases by
frequency × dt → compute joint torques from sin/cos(phase) × amplitude →
send to actuators → observe resulting motion → adjust coupling and damping
based on deviation from the desired trajectory.

The result is a smooth, self-sustaining trot that automatically adapts to
terrain irregularities and recovers from perturbations without explicit
re-planning.
