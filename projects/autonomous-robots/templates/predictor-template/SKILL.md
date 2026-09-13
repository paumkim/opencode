---
name: predictor-template
description: >
  A reusable predictor template for forecasting future states in loops and
  skills. Learns a model of system dynamics and uses it to predict future
  states, enabling anticipatory control and planning. Trigger keywords:
  predictive modeling, prediction, forecasting, model-based, state estimation,
  trajectory prediction, anomaly detection, predictive coding, Kalman filter,
  Bayesian inference, time series prediction.
---

# Predictor Template

## Purpose

Provide a reusable predictor template for forecasting future states in loops
and skills. The predictor template encapsulates the pattern of **observe →
model → predict → compare → adapt** that appears across robotics tasks:
trajectory prediction for obstacle avoidance, saliency prediction for attention
targeting, outcome prediction for manipulation planning, and anomaly detection
for error correction.

A predictor is appropriate when the task requires the robot to anticipate the
consequences of its actions before executing them, or to detect when reality
deviates from expectations. By learning a model of system dynamics, the
predictor enables proactive rather than reactive behavior.

## Core Concept

A predictor learns a model of the system's dynamics — a function that maps the
current state and action to the next state (or a sequence of future states).
This model can be analytical (derived from physics) or learned from data
(neural network, Gaussian process, Kalman filter). The learned model is then
used to forecast future states over a prediction horizon.

The key properties of a predictor are:

- **State representation** — a compact encoding of the system's current
  configuration (joint angles, object poses, velocities, etc.).
- **Transition model** — the learned or analytical function that predicts the
  next state given the current state and action.
- **Observation model** — maps the true state to observable sensor readings,
  accounting for sensor noise and partial observability.
- **Prediction horizon** — how far into the future the model forecasts. Longer
  horizons enable more proactive control but accumulate more uncertainty.

## Components

| Component | Description |
|-----------|-------------|
| **State representation** | A compact encoding of the system's current configuration. May include joint angles, object poses, velocities, and internal variables. Must capture all information needed for accurate prediction. |
| **Transition model** | The learned or analytical function that predicts the next state given the current state and action. Can be a neural network, Kalman filter, Gaussian process, or physics-based model. |
| **Observation model** | Maps the true (hidden) state to observable sensor readings. Accounts for sensor noise, occlusions, and partial observability. Used to update the state estimate from observations. |
| **Prediction horizon** | The number of time steps or duration into the future that the model forecasts. Longer horizons enable proactive control but accumulate uncertainty. |

## Usage

To apply this template to a loop or skill:

1. **Define the state representation** — specify what variables describe the
   system's current state. This should include all relevant information for
   predicting future states (positions, velocities, object poses, etc.).
2. **Choose the model type** — select an analytical model (physics-based,
   Kalman filter) or a learned model (neural network, Gaussian process) based
   on the system's complexity and available data.
3. **Train the model** — if using a learned model, collect training data by
   executing random or exploratory actions and recording (state, action, next
   state) tuples. Train the model to minimize prediction error.
4. **Set the prediction horizon** — determine how far ahead to predict. Short
   horizons (1–3 steps) are more accurate but less proactive; long horizons
   (10+ steps) enable planning but accumulate uncertainty.
5. **Integrate with the loop cycle** — the predictor runs inside the loop's
   cycle. Each iteration: observe current state → predict future states →
   compare predictions with actual observations → update model if error is
   high → use predictions to guide action selection.
6. **Handle prediction errors** — when the prediction error exceeds a
   threshold, trigger model retraining or signal the error-correction loop.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `prediction_horizon` | 5 steps | Number of time steps to forecast into the future. Longer horizons enable proactive control but accumulate uncertainty. |
| `model_complexity` | medium | Complexity of the learned model (e.g., neural network layer size). Higher complexity captures more dynamics but risks overfitting. |
| `update_rate` | 10 Hz | Frequency at which the model is updated with new observations. Higher rates adapt faster to changing dynamics. |
| `error_tolerance` | 0.05 | Maximum prediction error before the model is flagged for retraining or the error-correction loop is triggered. |

## Example

**Applying the predictor template to the attention loop for saliency prediction.**

The attention loop must track a moving target (a red ball) that may be
occluded by obstacles. The predictor template is used to estimate the target's
position when it is not directly observable:

- **State representation**: 6-dimensional vector including the target's
  position (x, y, z), velocity (vx, vy, vz), and a visibility flag indicating
  whether the target is currently in the camera's field of view.
- **Model type**: Kalman filter — a recursive estimator that fuses the target's
  motion model with noisy position observations. The motion model assumes
  constant velocity with Gaussian process noise.
- **Observation model**: Maps the true 3D position to the 2D pixel coordinates
  observed by the camera, accounting for perspective projection and detection
  noise.
- **Prediction horizon**: 10 steps (0.5 seconds at 20 Hz) — enough to
  anticipate the target's position during brief occlusions.

**Loop integration**: The attention loop runs the predictor at 20 Hz. Each
cycle:

1. **Observe**: If the target is visible, the camera provides a noisy 2D
   position measurement. If occluded, no observation is available.
2. **Predict**: The Kalman filter predicts the target's 3D position 10 steps
   ahead based on its current state and motion model.
3. **Update**: If the target is visible, the filter corrects its state estimate
   using the observation. If occluded, the prediction stands and the attention
   loop continues tracking based on the predicted position.
4. **Compare**: The prediction error is computed when the target reappears. If
   the error exceeds `error_tolerance`, the filter's process noise is
   increased to adapt to the target's actual motion pattern.
5. **Guide**: The predicted position is used to direct the camera to where the
   target will be, rather than where it was last seen, ensuring the target
   remains in view even during occlusions.

The result is smooth, continuous tracking of the target even when it is
temporarily hidden behind obstacles, enabling the attention loop to maintain
focus on the correct stimulus.
