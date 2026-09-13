---
name: attention
description: >
  The attention loop handles saliency detection and focus allocation. It scans
  incoming sensory data for interesting stimuli, computes saliency scores based on
  novelty, goal-relevance, and threat level, ranks stimuli by priority, allocates
  limited processing resources to the most important targets, tracks them as they
  move or change, and releases focus when they are no longer relevant. Trigger
  keywords: attention, saliency, focus, priority, stimulus detection, visual
  attention, selective attention, spotlight, relevance filtering, target detection.
---

# Attention Loop

## Purpose

The attention loop is the **selective awareness layer** of the autonomous robotics
framework. Where sensorimotor reacts to the present and planning anticipates the
future, attention decides *what* the robot should notice and *what* to ignore.
In high-dimensional sensory streams — a 360° camera array, a tactile skin, an
auditory field — not every signal deserves processing. The attention loop acts as
a dynamic spotlight, continuously scanning for salient stimuli, ranking them by
priority, and directing the robot's perceptual and computational resources toward
the most relevant targets.

The core cycle is: **scan → detect → score → rank → focus → track → release**.

## Inputs

- **Raw sensor data** from `sensorimotor` — unfiltered visual frames, LiDAR
  point clouds, auditory streams, tactile arrays, and proprioceptive readings.
  The attention loop receives the full sensory bandwidth before sensorimotor's
  filtering stage, so it can detect stimuli that might otherwise be suppressed.
- **Active goals** from `planning` — the current sub-goals, target objects, and
  task context. These provide top-down bias: a red ball is more salient when the
  robot is searching for a red ball.
- **Internal state** from `homeostasis` — battery level, motor temperature,
  fatigue estimates, and safety margins. A critically low battery makes
  charging stations highly salient; an overheating motor makes cooling vents
  salient.
- **Memory of past salience** from `memory` — previously attended targets,
  learned saliency priors, and context-dependent relevance patterns. This
  prevents the robot from re-attending to stimuli it has already processed.

## Processing

Each attention cycle performs six stages:

1. **Stimulus detection** — scan the raw sensory input for candidate stimuli.
   This is a bottom-up process: sudden luminance changes, motion onset, novel
   object shapes, unexpected sounds, tactile contact. Each candidate is a
   region or event that differs significantly from the expected sensory baseline.
2. **Saliency computation** — assign a saliency score to each candidate stimulus.
   The score combines bottom-up factors (intensity, contrast, motion, novelty)
   with top-down factors (goal-relevance from planning, threat level from
   homeostasis, learned priors from memory). The result is a normalized score
   in [0, 1].
3. **Priority ranking** — sort all detected stimuli by their saliency scores.
   The highest-scoring stimulus becomes the primary focus target. Stimuli
   below the `saliency_threshold` are discarded. The top N (up to
   `focus_capacity`) are retained as secondary targets for parallel tracking.
4. **Focus allocation** — direct processing resources to the ranked targets.
   This means instructing sensorimotor to increase sampling rate on the
   relevant sensors, directing planning to incorporate the target into the
   current task graph, and signaling meta-control that a high-priority event
   has been detected.
5. **Tracking** — follow the primary target as it moves or changes. The
   attention loop maintains a prediction of the target's trajectory (using the
   predictor template) and updates the saliency score as new sensory data
   arrives. If the target's score drops below threshold for longer than
   `tracking_timeout`, it is released.
6. **Release** — when a target is no longer salient (goal achieved, threat
   passed, or a higher-priority stimulus appears), release the focus and
   return resources to scanning mode. The released target's outcome is logged
   to memory for future saliency prior updates.

## Outputs

- **Salient targets** — the set of currently detected stimuli with their
  saliency scores, spatial locations, and semantic labels. Delivered to
  planning for goal-relevance assessment and to sensorimotor for focused
  sensing.
- **Priority-ranked stimulus list** — an ordered list of all detected stimuli,
  ranked by saliency score. Used by meta-control for arbitration when multiple
  loops compete for resources.
- **Focus commands** — directives to sensorimotor specifying which sensors to
  prioritize, which regions of the visual field to sample at high resolution,
  and which actuators to prepare for interaction.
- **Attention shift signals** — interrupts sent to meta-control when a new
  stimulus exceeds the current focus's saliency by a margin, indicating that
  the robot's attention should be redirected.

## Loop Cycle

```
scan → detect → score → rank → focus → track → release
```

| Stage | Description |
|-------|-------------|
| **scan** | Sweep the full sensory bandwidth for candidate stimuli. |
| **detect** | Identify regions or events that differ from the expected baseline. |
| **score** | Compute a combined bottom-up + top-down saliency score for each candidate. |
| **rank** | Sort candidates by saliency; discard those below `saliency_threshold`. |
| **focus** | Allocate processing resources to the top-ranked targets; issue focus commands. |
| **track** | Follow the primary target's trajectory; update saliency as new data arrives. |
| **release** | Drop focus when the target is no longer salient; return to scanning. |

## Templates

The attention loop selects a template based on the structure of the saliency
problem and the available models:

| Template | Use Case | Characteristics |
|----------|----------|-----------------|
| **FSM** (`fsm-template`) | Attention state management | Manages the lifecycle of a focus target through discrete states: `SCANNING → DETECTED → SCORING → FOCUSED → TRACKING → RELEASED`. Transitions are triggered by saliency thresholds, goal completion, and timeout events. Best for well-structured attention tasks with clear state transitions. |
| **Predictor** (`predictor-template`) | Saliency prediction | Uses a learned or analytical model to predict the future position and saliency of a tracked target. The model is trained on past target trajectories and saliency dynamics. Best for tracking moving targets and anticipating when a stimulus will become relevant. |
| **RL** (`rl-template`) | Attention policy learning | Learns an attention policy — which stimuli to attend to and when to shift focus — through trial and reward. The policy is rewarded for attending to goal-relevant stimuli and penalized for fixating on distractors. Best for complex environments where saliency priors are difficult to specify analytically. |

## Integration

The attention loop is a **middle layer** that bridges sensorimotor's raw perception
and planning's goal-directed reasoning:

- **Meta-control** (upstream): Reports high-priority stimuli that may require
  task re-sequencing. When a stimulus exceeds the `attention_threshold`, the
  attention loop sends an interrupt to meta-control, which may pause the current
  task and re-sequence loops. Meta-control also receives the priority-ranked
  stimulus list for resource arbitration when multiple loops compete.
- **Sensorimotor** (downstream): Receives focus commands specifying which
  sensors to prioritize and which regions to sample at high resolution.
  Sensorimotor streams raw, unfiltered sensory data to attention for stimulus
  detection. When attention shifts focus, sensorimotor adjusts its filtering
  and classification to match the attended target.
- **Planning** (sideways): Receives salient targets for goal-relevance
  assessment. Planning provides active goals and task context to bias
  bottom-up saliency scores. When a goal-relevant target is detected, planning
  incorporates it into the current task graph. Planning also receives
  attention shift signals when a new high-priority stimulus appears.
- **Homeostasis** (sideways): Provides internal state (battery, temperature,
  fatigue) as top-down saliency bias. A low battery makes charging stations
  salient; an overheating motor makes cooling vents salient. Homeostasis
  receives attention shift signals when a threat-level stimulus is detected.
- **Memory** (sideways): Provides learned saliency priors and context-dependent
  relevance patterns. Stores attended targets and their outcomes for future
  prior updates. When attention releases a target, the outcome is logged to
  memory to improve future saliency predictions.
- **Learning** (sideways): Receives focused experience data — the sensory
  streams and outcomes from attended targets — for policy improvement. Learning
  provides updated saliency models and attention policies from the RL template.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `scan_rate` | 30 Hz | Frequency at which the full sensory bandwidth is scanned for new stimuli |
| `saliency_threshold` | 0.3 | Minimum combined saliency score for a stimulus to be retained for focus |
| `focus_capacity` | 3 | Maximum number of targets that can be tracked simultaneously |
| `tracking_timeout` | 2.0s | Maximum time a target can remain below threshold before focus is released |
| `attention_threshold` | 0.8 | Saliency score above which an attention shift signal is sent to meta-control |
| `priority_weights` | `{novelty: 0.3, goal_relevance: 0.4, threat: 0.3}` | Relative weights for bottom-up vs. top-down saliency factors |

## Example

**Task**: A mobile robot is exploring an unknown environment and must locate a
red ball that has been placed somewhere in the space.

1. **scan**: The attention loop sweeps the 360° camera array and LiDAR at 30 Hz,
   looking for any deviation from the expected sensory baseline. The environment
   is mostly uniform — walls, floor, a few scattered objects.
2. **detect**: Three candidate stimuli are detected: a moving shadow (motion
   onset), a bright spot on the wall (luminance change), and a small red object
   partially hidden behind a chair (novel shape + color).
3. **score**: The saliency scores are computed:
   - Moving shadow: 0.45 (high novelty, low goal-relevance, low threat)
   - Bright spot: 0.35 (moderate intensity, no goal-relevance)
   - Red object: 0.82 (moderate novelty, high goal-relevance from planning's
     "find red ball" objective, low threat)
4. **rank**: The red object ranks highest at 0.82, above the
   `saliency_threshold` of 0.3. The moving shadow (0.45) is retained as a
   secondary target. The bright spot (0.35) is borderline but kept.
5. **focus**: The attention loop sends a focus command to sensorimotor:
   "increase camera resolution on the region behind the chair, prioritize
   color classification for red objects." Planning receives the salient target
   list and confirms the red object matches the current goal.
6. **track**: The robot moves toward the chair. The red object is partially
   occluded, so the predictor template estimates its likely position based on
   the last known trajectory. As the robot approaches, the object becomes
   fully visible — it is indeed the red ball.
7. **release**: The robot grasps the ball. The goal is achieved, so the
   attention loop releases focus on the red ball and returns to scanning mode.
   The successful detection and tracking outcome is logged to memory,
   strengthening the saliency prior for "red objects when searching for red
   balls."

Throughout, the attention loop reports the high-priority detection (saliency
0.82 > `attention_threshold` 0.8) to meta-control, which confirms the task
re-alignment. The moving shadow remains as a secondary tracked target in case
it becomes relevant.
