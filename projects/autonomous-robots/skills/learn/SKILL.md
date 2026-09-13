---
name: learn
description: >
  The learn skill acquires new skills and improves existing ones through
  practice, error analysis, and generalization. It decomposes tasks, schedules
  practice, analyzes errors, and transfers learning across contexts. Trigger
  keywords: skill learning, motor learning, procedural learning, habit
  formation, skill acquisition, competence improvement, performance
  adaptation, behavioral plasticity, skill transfer, meta-learning.
---

# Learn Skill

## Purpose

Acquire new skills and improve existing ones through practice, error analysis,
and generalization. The learn skill is the **skill development layer** invoked
by the meta-control loop when new capabilities are needed or existing
performance must be improved. It takes task performance data and error signals,
decomposes complex skills into manageable components, schedules practice
sessions, analyzes failures, and packages learned improvements as reusable
skills.

## Inputs

- **Task performance data** from `sensorimotor` — streams of (state, action,
  outcome) tuples captured during execution, including prediction errors and
  unexpected events.
- **Error signals** from `error-correction` — anomaly classifications, recovery
  outcomes, and root-cause attributions for failures.
- **Feedback** from `planning` — plan success/failure rates, trajectory
  deviation magnitudes, and cost model accuracy over time.

## Processing

Each learn cycle performs six stages:

1. **Observe** — collect performance data and error signals from sensorimotor,
   error-correction, and planning. Aggregate into a structured experience
   buffer with context annotations (task, environment, resource state).
2. **Analyze** — examine the collected data to identify patterns in successes
   and failures. Decompose complex skills into sub-skills that can be learned
   independently. Identify the root causes of errors.
3. **Practice** — execute the selected learning algorithm (RL, predictor, CPG)
   on the decomposed sub-skills. Run multiple practice episodes, adjusting
   parameters based on feedback.
4. **Evaluate** — assess the performance of the updated or newly learned skill
   against a held-out validation set. Measure improvement in task success rate,
   efficiency, and robustness.
5. **Refine** — iterate on the learning process based on evaluation results.
   Adjust hyperparameters, modify the reward function, or change the model
   architecture to improve learning outcomes.
6. **Generalize** — transfer learned improvements across related tasks and
   contexts. Apply regularization, data augmentation, or domain randomization to
   prevent overfitting. Package the learned skill for reuse.

## Outputs

- **New skills** — emergent capabilities discovered through practice that are
  packaged as reusable skills and registered with meta-control.
- **Improved policies** — refined parameter sets for existing skills (e.g.,
  improved grasp force mappings, better obstacle avoidance thresholds).
- **Skill libraries** — organized collections of learned skills with metadata
  (success rates, applicable contexts, required resources) for future retrieval.

## Loop Cycle

```
observe → analyze → practice → evaluate → refine → generalize
```

| Stage | Description |
|-------|-------------|
| **observe** | Collect performance data and error signals from sensorimotor, error-correction, and planning. |
| **analyze** | Identify patterns in successes and failures; decompose complex skills into sub-skills. |
| **practice** | Execute the learning algorithm on sub-skills; run multiple practice episodes. |
| **evaluate** | Assess updated or new skills against validation data; measure improvement. |
| **refine** | Iterate on the learning process; adjust hyperparameters and reward functions. |
| **generalize** | Transfer improvements across tasks; package learned skills for reuse. |

## Templates

The learn skill selects a template based on the nature of the learning problem:

| Template | Use Case | Characteristics |
|----------|----------|-----------------|
| **RL** (`rl-template`) | Policy learning | Reinforcement learning via policy gradient, Q-learning, or actor-critic. Learns a mapping from states to actions that maximizes cumulative reward. Best for tasks with clear reward signals and sufficient exploration budget. |
| **Predictor** (`predictor-template`) | Skill modeling | Trains a forward dynamics or outcome-prediction model from experience data. The learned model is used to anticipate the consequences of actions and improve planning. Best for improving trajectory prediction and reducing surprise. |
| **CPG** (`cpg-template`) | Motor pattern learning | Adapts central pattern generator parameters to refine rhythmic or periodic motor behaviors (walking, swimming, manipulation rhythms). Uses gradient-free optimization or biological learning rules (e.g., Hebbian plasticity) to tune oscillator coupling and phase offsets. |

## Integration

The learn skill is invoked by the **meta-control loop** and connects to the
broader framework as follows:

- **Learning loop** (executes): The learn skill is the concrete implementation
  of the learning loop's abstract cycle. The learning loop provides the
  high-level orchestration (explore → observe → reward → learn → update →
  generalize); the learn skill provides the detailed skill-specific logic
  (decompose → practice → evaluate → refine).
- **Planning** (receives new skills): When the learn skill packages a new skill,
  it registers it with planning, which can then incorporate it into future task
  graphs. Planning also provides performance metrics and task context to guide
  learning.
- **Memory** (stores skills): Stores learned policy parameters, new skill
  definitions, and generalization results as semantic knowledge. Retrieves
  episodic traces for experience replay and historical context for reward
  shaping.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `practice_episodes` | 100 | Number of practice episodes to run per learning cycle. |
| `evaluation_threshold` | 0.85 | Minimum performance metric (e.g., success rate) required to accept a learned skill. |
| `transfer_rate` | 0.5 | Fraction of learned improvements to transfer to related tasks. Range [0, 1]. |
| `retention_period` | 3600 s | Time window for retaining practice data before archiving to memory. |

## Example

**Task**: A robot must learn a new maze-solving strategy through practice.

1. **observe**: The robot's previous maze-solving attempts are collected from
   sensorimotor — (state, action, outcome) tuples including wall-following
   paths, dead-end encounters, and successful routes. Error-correction provides
   anomaly data from failed attempts (wrong turns, collisions).
2. **analyze**: The learn skill decomposes maze-solving into sub-skills:
   wall-following, dead-end detection, shortcut identification, and goal
   approach. It identifies that the robot's current wall-following strategy is
   inefficient — it takes too many turns and frequently revisits dead ends.
3. **practice**: Using the RL template, the learn skill runs 100 practice
   episodes in a simulated maze environment. The agent learns a policy that
   balances exploration (trying new paths) with exploitation (using known
   efficient routes). The reward function gives +10 for reaching the goal, -1
   per step to encourage efficiency, and -5 for revisiting a dead end.
4. **evaluate**: The learned policy is tested on 20 unseen mazes. It achieves
   an 88% success rate with an average of 15 steps per maze (down from 25 with
   the old strategy). This exceeds the `evaluation_threshold` of 85%.
5. **refine**: The learn skill adjusts the exploration rate and reward weights
   to further improve performance. After 20 more episodes, the success rate
   reaches 92%.
6. **generalize**: The learned maze-solving policy is packaged as a new skill
   and registered with planning. The skill includes metadata: "effective in
   mazes up to 10×10 grid, success rate 92%, requires camera and LiDAR." The
   policy parameters are stored in memory for future retrieval.

Over multiple learning cycles, the robot's maze-solving performance improves
from 60% to 92% success rate, and the learned skill is available for future
maze tasks.
