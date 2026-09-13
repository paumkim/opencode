---
name: rl-template
description: >
  A reusable reinforcement learning (RL) template for adaptive control in loops
  and skills. An agent learns an optimal policy through trial and reward,
  improving its behavior over time without explicit programming. Trigger
  keywords: reinforcement learning, RL, policy gradient, Q-learning, actor-critic,
  value iteration, policy iteration, reward shaping, exploration strategy,
  policy optimization.
---

# RL Template

## Purpose

Provide a reusable reinforcement learning (RL) template for implementing
adaptive control in loops and skills. The RL template encapsulates the pattern
of **agent → environment → action → reward → policy update** that appears
across robotics tasks: grasp policy improvement, navigation policy learning,
dialogue policy optimization, and motor skill refinement.

RL is appropriate when the task requires the robot to adapt its behavior based
on experience — when the optimal action is not known a priori and must be
discovered through interaction. The agent learns a policy (a mapping from states
to actions) that maximizes cumulative reward over time.

## Core Concept

Reinforcement learning consists of an agent interacting with an environment.
At each time step, the agent observes the current state, selects an action
according to its policy, and receives a reward signal. The agent's goal is to
learn a policy that maximizes the expected cumulative reward (return).

The key components of an RL system are:

- **Policy** — the agent's strategy, a mapping from states to actions. Can be
  deterministic (state → action) or stochastic (state → action probability
  distribution).
- **Value function** — estimates how good a state (or state-action pair) is in
  terms of expected future reward. Guides the agent toward rewarding states.
- **Reward function** — provides immediate feedback on each action. The design
  of the reward function is critical: it must align with the task objective
  while being learnable.
- **Exploration strategy** — balances exploiting known rewarding actions with
  exploring new actions that might yield higher rewards. Common strategies
  include ε-greedy, softmax, and noise injection.

## Components

| Component | Description |
|-----------|-------------|
| **Policy** | The agent's behavior strategy. Maps states to actions (deterministic) or action probabilities (stochastic). Updated through policy gradient or Q-learning. |
| **Value function** | Estimates the expected cumulative reward from a state (or state-action pair). Used to evaluate and improve the policy. Can be a critic in actor-critic methods. |
| **Reward function** | Scalar feedback signal received after each action. Combines task success, efficiency, safety, and other objectives. May include shaping terms to guide learning. |
| **Exploration strategy** | Mechanism for trying new actions to discover better policies. Includes ε-greedy, entropy regularization, noise injection, and curiosity-driven exploration. |

## Usage

To apply this template to a loop or skill:

1. **Define the state space** — specify what the agent observes. This may
   include sensor readings, joint angles, object positions, or internal state
   variables. The state must be Markovian (contain all information needed to
   make optimal decisions).
2. **Define the action space** — specify what actions the agent can take. This
   may be discrete (e.g., move forward, turn left, turn right) or continuous
   (e.g., joint torque commands, velocity vectors).
3. **Design the reward function** — assign scalar rewards that align with the
   task objective. Positive rewards for desired outcomes (reaching the goal,
   successful grasp), negative rewards for failures (collisions, dropped
   objects), and shaping rewards to guide exploration (progress toward goal).
4. **Select the learning algorithm** — choose from policy gradient methods
   (REINFORCE, PPO, TRPO), value-based methods (Q-learning, DQN), or
   actor-critic methods (A3C, SAC, DDPG) depending on the action space and
   problem structure.
5. **Configure the exploration strategy** — set the initial exploration rate
   and decay schedule. Higher exploration early in training, gradually
   decreasing as the policy improves.
6. **Wire to the loop cycle** — the RL agent runs inside the loop's cycle.
   Each iteration: observe state → select action (with exploration) → execute
   action → receive reward → store experience → update policy.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `learning_rate` | 0.01 | Step size for policy parameter updates. Higher values learn faster but may be unstable. |
| `discount_factor` | 0.95 | Discount factor γ for future rewards in value estimation. Higher values consider longer horizons. |
| `exploration_rate` | 0.2 | Fraction of actions taken randomly to gather novel experience. Decays over training. |
| `batch_size` | 64 | Number of experience tuples per gradient update. Larger batches reduce variance. |
| `convergence_threshold` | 0.001 | Minimum policy improvement per iteration to continue training. Below this, learning is considered converged. |

## Example

**Applying the RL template to the learning loop for grasp policy improvement.**

A robotic arm must learn to grasp novel objects it has never encountered before.
The RL template is instantiated within the learning loop:

- **State space**: 12-dimensional vector including object pose (x, y, z, roll,
  pitch, yaw), gripper pose, finger positions, tactile pressure readings, and
  previous action.
- **Action space**: Continuous 7-dimensional vector — 3D gripper position
  target, 3D gripper orientation target, and gripper aperture.
- **Reward function**: +10 for successful grasp (object lifted without slip),
  -10 for failed grasp (object dropped or not contacted), -0.1 per time step
  to encourage speed, -1 for excessive grip force to encourage gentleness.
- **Algorithm**: PPO (Proximal Policy Optimization) — an actor-critic method
  that updates the policy using clipped surrogate objectives for stability.
- **Exploration**: Gaussian noise added to actions during training, with
  standard deviation decaying from 0.5 to 0.05 over 10,000 episodes.

**Loop integration**: The learning loop runs the RL agent at 10 Hz. Each
iteration:

1. **Observe**: The arm's current state (joint angles, object pose from
   camera, tactile readings) is assembled into the state vector.
2. **Act**: The policy network outputs a 7D action (gripper target pose and
   aperture). Exploration noise is added during training.
3. **Execute**: The action is sent to the sensorimotor loop, which commands
   the arm to move and grasp.
4. **Reward**: After the grasp attempt, the learning loop computes the reward
   based on whether the object was successfully lifted.
5. **Learn**: The experience tuple (state, action, reward, next state) is
   stored in a replay buffer. Every `batch_size` steps, a batch is sampled and
   the policy is updated via PPO.
6. **Update**: The improved policy parameters are written back to the learning
   loop. The next grasp attempt uses the updated policy.

Over 5,000 training episodes, the arm's grasp success rate improves from 30% to
95%. The learned policy generalizes to novel object shapes and is registered
with meta-control as a reusable grasp skill.
