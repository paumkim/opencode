---
name: learning
description: >
  The learning loop handles adaptation from experience and policy improvement. It
  collects experience data, computes reward signals, evaluates current policies,
  improves them through gradient-based or evolutionary updates, and generalizes
  across tasks. Trigger keywords: learning, adaptation, reinforcement learning,
  policy improvement, experience-based, training, neural plasticity, skill
  acquisition.
---

# Learning Loop

## Purpose

The learning loop is the **adaptation layer** of the autonomous robotics framework.
Where sensorimotor reacts to the present and planning anticipates the future,
learning improves the robot's behavior based on what it has experienced. It closes
the gap between expected and actual performance, turning mistakes into better
policies and novel situations into reusable skills.

The core cycle is: **explore → observe → reward → learn → update → generalize**.

## Inputs

- **Experience data** from `sensorimotor` — streams of (state, action, outcome)
  tuples captured during execution, including prediction errors and unexpected
  events.
- **Performance metrics** from `planning` — plan success/failure rates, trajectory
  deviation magnitudes, and cost model accuracy over time.
- **Error signals** from `error-correction` — anomaly classifications, recovery
  outcomes, and root-cause attributions for failures.
- **Memory** from `memory` — episodic traces of past trials, semantic summaries of
  successful strategies, and previously learned policy parameters.

## Processing

Each learning cycle performs five stages:

1. **Data collection** — aggregate experience tuples from sensorimotor, planning,
   and error-correction into a replay buffer. Filter for relevance, de-duplicate,
   and annotate with context (task, environment, resource state).
2. **Reward computation** — assign scalar reward signals to each experience tuple.
   Combine task success, efficiency, safety margins, and resource usage into a
   composite reward function. Negative rewards (penalties) are assigned to
   anomalies and failures.
3. **Policy evaluation** — assess the current policy's expected return over the
   collected data. Estimate value functions, advantage estimates, or fitness
   scores depending on the template in use.
4. **Policy improvement** — update policy parameters to increase expected return.
   This may use gradient ascent (RL), evolutionary strategies, or supervised
   updates from successful demonstrations.
5. **Generalization** — transfer learned improvements across related tasks and
   contexts. Apply regularization, data augmentation, or domain randomization to
   prevent overfitting to specific experiences.

## Outputs

- **Updated policies** — refined parameter sets for sensorimotor templates (e.g.,
  improved grasp force mappings, better obstacle avoidance thresholds).
- **New skills** — emergent capabilities discovered through exploration that are
  packaged as reusable skills and registered with meta-control.
- **Parameter adjustments** — tuned hyperparameters for other loops (e.g., adjusted
  attention thresholds, modified planning risk tolerance).
- **Exploration strategies** — updated curiosity or uncertainty-sampling policies
  that guide future data collection.

## Loop Cycle

```
explore → observe → reward → learn → update → generalize
```

| Stage | Description |
|-------|-------------|
| **explore** | Execute actions that gather informative experience — either following the current policy with added noise, or actively seeking novel states via curiosity-driven exploration. |
| **observe** | Collect the resulting state, action, and outcome data from sensorimotor and planning. |
| **reward** | Compute scalar reward signals from task success, efficiency, safety, and error-correction feedback. |
| **learn** | Run the selected learning algorithm (policy gradient, Q-learning, evolutionary strategy) on the collected data. |
| **update** | Apply parameter updates to the policy, value function, or skill representation. |
| **generalize** | Transfer improvements across tasks, apply regularization, and package new skills for reuse. |

## Templates

The learning loop selects a template based on the nature of the learning problem:

| Template | Use Case | Characteristics |
|----------|----------|-----------------|
| **RL** (`rl-template`) | Policy optimization from reward signals | Reinforcement learning via policy gradient, Q-learning, or actor-critic. Learns a mapping from states to actions that maximizes cumulative reward. Best for tasks with clear reward signals and sufficient exploration budget. |
| **Predictor** (`predictor-template`) | Predictive model learning | Trains a forward dynamics or outcome-prediction model from experience data. The learned model is used by planning and sensorimotor to anticipate consequences of actions. Best for improving trajectory prediction and reducing surprise. |
| **CPG** (`cpg-template`) | Motor skill refinement | Adapts central pattern generator parameters to refine rhythmic or periodic motor behaviors (walking, swimming, manipulation rhythms). Uses gradient-free optimization or biological learning rules (e.g., Hebbian plasticity) to tune oscillator coupling and phase offsets. |

## Integration

The learning loop is a **cross-cutting layer** that connects to all other loops:

- **Meta-control** (upstream): Reports learning progress, new skill discoveries,
  and confidence levels in updated policies. When learning produces a significant
  improvement, it signals meta-control to re-sequence dependent sub-tasks with the
  updated model. If learning detects a persistent performance gap, it requests
  meta-control to allocate additional exploration budget.
- **Sensorimotor** (downstream): Receives updated control policies and parameter
  adjustments. Streams (state, action, outcome) experience data for offline
  learning. When learning produces a new policy, sensorimotor can hot-swap to the
  improved version at the next safe boundary.
- **Planning** (sideways): Receives improved cost models and dynamics predictions
  from the predictor template. Planning reports plan success/failure data and
  trajectory deviations. When planning's models are updated, it re-evaluates
  pending plans with the new parameters.
- **Memory** (sideways): Stores learned policy parameters, new skill definitions,
  and generalization results as semantic knowledge. Retrieves episodic traces for
  experience replay and historical context for reward shaping.
- **Error-correction** (sideways): Receives anomaly classifications and recovery
  outcomes as negative reward signals. Error-correction uses learning to improve
  its own anomaly detection thresholds and recovery policy over time.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `learning_rate` | 0.01 | Step size for policy parameter updates |
| `exploration_rate` | 0.2 | Fraction of actions taken randomly to gather novel experience |
| `reward_discount` | 0.95 | Discount factor γ for future rewards in value estimation |
| `batch_size` | 64 | Number of experience tuples per gradient update |
| `convergence_threshold` | 0.001 | Minimum policy improvement per iteration to continue training |
| `replay_buffer_size` | 10000 | Maximum number of experience tuples retained for replay |

## Example

**Task**: A robotic arm must learn to grasp novel objects it has never encountered
before.

1. **explore**: The arm attempts to grasp a new object using its current grasp
   policy, adding random perturbations to finger positioning and grip force.
2. **observe**: Sensorimotor streams the tactile, visual, and proprioceptive data
   from the attempt — the object slipped, grasp force was 2.3 N, finger positions
   were [0.12, 0.08, 0.15] radians.
3. **reward**: The learning loop computes a reward of -0.8 (failure: object
   dropped) based on task success, plus a small penalty for excessive grip force
   that could damage delicate objects.
4. **learn**: Using the RL template, the loop runs a policy gradient update on the
   collected batch of grasp attempts. The policy learns that wider finger spread
   and slightly higher grip force improve success on this object category.
5. **update**: The updated grasp policy parameters are written to the sensorimotor
   loop's grasp controller. The next grasp attempt uses the improved policy.
6. **generalize**: The learning loop recognizes that this object shares geometric
   features with previously encountered objects and applies transfer learning to
   adapt the policy for similar shapes. It packages the refined grasp strategy as
   a new skill and registers it with meta-control.

Over multiple iterations, the arm's grasp success rate improves from 40% to 92%,
and the learned skill is available for future objects in the same category.
