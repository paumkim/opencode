---
name: social
description: >
  The social loop handles human-robot interaction and social intelligence. It
  observes human gestures, speech, and facial expressions, interprets social
  signals and intent, generates appropriate social responses, and adapts its
  behavior to comply with social norms and collaboration expectations. Trigger
  keywords: social interaction, human-robot interaction, HRI, social signal,
  empathy, collaboration, teamwork, social cue, multi-agent, social
  intelligence, interpersonal communication.
---

# Social Loop

## Purpose

The social loop is the **interpersonal layer** of the autonomous robotics
framework. Where sensorimotor reacts to the physical world and planning
anticipates task goals, the social loop interprets the *social* world — the
gestures, speech, facial expressions, and implicit signals that humans use to
communicate intent, emotion, and collaboration cues. It is the robot's social
nervous system: always listening, always watching, always adapting its behavior
to be a trustworthy, predictable, and effective collaborator.

The core cycle is: **observe → interpret → plan → respond → monitor → adapt**.

## Inputs

- **Human gestures** from `sensorimotor` — body posture, hand movements, pointing
  directions, and proxemic positioning captured by cameras, depth sensors, and
  pose estimation pipelines.
- **Speech** from `sensorimotor` — spoken language, tone, prosody, and speech
  rate captured by microphone arrays and processed through speech-to-text and
  sentiment analysis.
- **Facial expressions** from `sensorimotor` — emotional cues (joy, frustration,
  confusion, surprise) detected via facial landmark tracking and expression
  classification.
- **Task context** from `meta-control` — the current mission, active sub-goals,
  and the human's role in the task (supervisor, collaborator, bystander). This
  provides top-down context for interpreting ambiguous social signals.
- **Salient social cues** from `attention` — prioritized social stimuli that
  attention has flagged as high-priority (e.g., a human looking directly at the
  robot, a pointing gesture, a sudden tone shift in speech).

## Processing

Each social cycle performs five stages:

1. **Signal detection** — scan incoming sensory data for social signals. This
   is a bottom-up process: gesture onset, speech activity, facial expression
   changes, gaze direction, and proxemic shifts. Each detected signal is
   timestamped and tagged with its source (gesture, speech, face, posture).
2. **Intent inference** — interpret the detected signals to infer the human's
   intent, emotional state, and collaboration needs. This combines the signals
   with task context from meta-control: a pointing gesture during a navigation
   task likely indicates a redirection; the same gesture during a manipulation
   task may indicate a target object. The predictor template may be used to
   forecast the human's next action based on observed patterns.
3. **Response planning** — generate an appropriate social response. This includes
   deciding what to communicate (information content), how to communicate it
   (modality: speech, gesture, visual signal), and when to communicate it
   (timing relative to the ongoing task). The plan must comply with social
   norms — e.g., not interrupting a human who is speaking, acknowledging a
   gesture before acting on it.
4. **Response generation** — produce the planned response through the
   `communicate` skill. This may involve text-to-speech synthesis, motor
   commands for gestures, or LED/light patterns for visual signals. The
   response is delivered at the appropriate moment, respecting the human's
   attention and engagement level.
5. **Social norm compliance** — evaluate the generated response against
   cultural and task-specific social norms. Does the response respect personal
   space? Is the timing appropriate? Does the modality match the urgency and
   context? If a norm violation is detected, the response is revised before
   delivery.

## Outputs

- **Social responses** — verbal and non-verbal outputs delivered through the
  `communicate` skill: spoken acknowledgments, gesture-based confirmations,
  visual status signals, and contextual information sharing.
- **Collaboration signals** — intent signals that coordinate joint action with
  humans: readiness indicators, progress updates, request-for-clarification
  signals, and turn-taking cues that facilitate smooth human-robot teamwork.
- **Intent signals** — structured representations of inferred human intent
  (e.g., "human wants to redirect the robot to location X") delivered to
  `planning` and `meta-control` for task re-sequencing.
- **Social context** — a summary of the current social state (human engagement
  level, emotional valence, collaboration mode) delivered to `meta-control`
  to bias task decomposition and loop selection.

## Loop Cycle

```
observe → interpret → plan → respond → monitor → adapt
```

| Stage | Description |
|-------|-------------|
| **observe** | Scan incoming sensory data from sensorimotor for social signals (gestures, speech, facial expressions, gaze, proxemics). |
| **interpret** | Infer human intent, emotional state, and collaboration needs from detected signals, using task context from meta-control. |
| **plan** | Generate an appropriate social response — what to communicate, how, and when — complying with social norms. |
| **respond** | Produce the planned response through the communicate skill (speech, gestures, visual signals). |
| **monitor** | Observe the human's reaction to the response — acknowledgment, confusion, frustration — to assess effectiveness. |
| **adapt** | Adjust future social behavior based on the human's response and engagement level. Update intent inference models and response policies. |

## Templates

The social loop selects a template based on the structure of the social
interaction and the available models:

| Template | Use Case | Characteristics |
|----------|----------|-----------------|
| **FSM** (`fsm-template`) | Social state management | Manages the lifecycle of a social interaction through discrete states: `IDLE → OBSERVING → INTERPRETING → PLANNING → RESPONDING → MONITORING → ADAPTING`. Transitions are triggered by signal detection, intent confidence thresholds, and response acknowledgment. Best for structured interactions with clear phases like status reporting or task handoff. |
| **Predictor** (`predictor-template`) | Intent prediction | Uses a learned or analytical model to predict the human's next action or intent based on observed social signals and task context. The model is trained on past interaction data — gesture sequences, speech patterns, and their outcomes. Best for anticipating human needs and proactively preparing responses. |
| **RL** (`rl-template`) | Social policy learning | Learns an optimal social policy — what response to generate, when, and in what modality — through trial and reward. The policy is rewarded for successful communication (human acknowledgment, task progress) and penalized for miscommunication (confusion, frustration, norm violations). Best for complex, open-ended interactions where optimal social behavior is difficult to specify analytically. |

## Integration

The social loop is a **sideways layer** that activates when humans are present
or when multi-agent coordination is required:

- **Meta-control** (upstream): Receives social context — human engagement level,
  emotional valence, collaboration mode — to bias task decomposition and loop
  selection. When the social loop detects a high-priority social signal (e.g., a
  human pointing to redirect the robot), it sends an intent signal to
  meta-control, which may re-sequence the current task. Meta-control also
  provides task context that helps the social loop interpret ambiguous signals.
- **Sensorimotor** (upstream): Receives social signals — human gestures, speech,
  facial expressions, gaze direction — from sensorimotor's perception pipeline.
  Sensorimotor streams raw sensory data (camera frames, microphone audio) that
  the social loop processes for social signal detection. When the social loop
  generates a response, it sends motor commands (for gestures) and audio output
  (for speech) back through sensorimotor for execution.
- **Communicate skill** (downstream): Generates the actual social responses —
  speech, gestures, visual signals — based on the social loop's response plan.
  The communicate skill handles modality selection, message composition, and
  delivery. The social loop provides the semantic content and timing; the
  communicate skill handles the production.
- **Attention** (sideways): Receives prioritized social cues from attention —
  high-saliency social stimuli (direct gaze, pointing gestures, tone shifts)
  that attention has flagged as requiring immediate processing. The social loop
  uses these prioritized cues to focus its signal detection. In return, the
  social loop can bias attention's saliency computation to prioritize
  human-related stimuli.
- **Planning** (sideways): Receives inferred human intent signals (e.g.,
  "human wants to redirect to location X") for task re-sequencing. Planning
  provides task context and upcoming action sequences that help the social loop
  anticipate when social responses will be needed.
- **Memory** (sideways): Stores successful social interaction patterns and
  learned social norms for future recall. Retrieves historical context about
  the human collaborator (preferred communication style, past interactions,
  relationship history) to personalize responses.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `social_sensitivity` | 0.7 | Threshold for detecting social signals. Higher values require stronger signals before triggering a social response. Range [0, 1]. |
| `response_latency` | 0.5 s | Maximum delay between detecting a social signal and generating a response. Lower values prioritize immediacy; higher values allow more thorough interpretation. |
| `collaboration_weight` | 0.6 | Relative weight given to collaboration cues vs. task efficiency when planning responses. Higher values prioritize human comfort and engagement over task speed. Range [0, 1]. |
| `norm_compliance` | 0.9 | Minimum compliance score for a response to be delivered without revision. Responses below this threshold are revised to better comply with social norms. Range [0, 1]. |
| `intent_confidence_threshold` | 0.8 | Minimum confidence in inferred human intent required to act on it. Below this threshold, the social loop requests clarification rather than acting. Range [0, 1]. |
| `engagement_timeout` | 10.0 s | Maximum time without social signals before the social loop assumes the human is disengaged and reduces social signaling frequency. |

## Example

**Task**: A mobile robot is exploring a maze to locate a red ball. A human
supervisor is observing from the entrance and wants to redirect the robot's
exploration.

1. **observe**: The robot's camera detects a human gesture — the supervisor is
   pointing toward the left corridor. The speech-to-text system detects no
   spoken words, but the prosody analysis notes a slight tone shift. The facial
   expression classifier detects a neutral-to-focused expression. Attention has
   flagged this as a high-saliency social cue (direct gaze + pointing gesture).
2. **interpret**: The social loop combines the pointing gesture with task
   context from meta-control ("exploring maze, locate red ball"). The gesture
   direction (left corridor) and the supervisor's focused expression suggest
   the human wants the robot to explore the left branch. Intent confidence is
   0.85, above the `intent_confidence_threshold` of 0.8.
3. **plan**: The social loop generates a response plan: acknowledge the
   redirection with a brief verbal confirmation ("Redirecting to the left
   corridor") and a nodding gesture, then update the exploration target. The
   response complies with social norms — it acknowledges the human's input
   before acting, and the timing respects the human's attention (the robot is
   not currently executing a critical maneuver).
4. **respond**: The social loop sends the response plan to the communicate
   skill. The communicate skill selects speech as the modality (the supervisor
   is 3 meters away and facing the robot), synthesizes the audio output, and
   sends a nodding gesture command to sensorimotor. The response is delivered
   within `response_latency` of 0.5 seconds.
5. **monitor**: The robot observes the supervisor's reaction — a slight nod
   and a smile indicating acknowledgment. The engagement level remains high
   (the supervisor is still watching).
6. **adapt**: The social loop notes that the acknowledgment gesture + verbal
   confirmation was effective (the supervisor responded positively). This
   interaction pattern is stored in memory for future use. The intent inference
   model is updated to weight pointing gestures more heavily when the human is
   in a supervisory role.

Meanwhile, the inferred intent signal ("redirect to left corridor") is sent to
planning, which re-sequences the exploration task to prioritize the left branch.
Meta-control receives the social context update (supervisor engaged, intent
inferred) and confirms the task re-sequencing. The robot navigates toward the
left corridor, periodically checking back with the supervisor to confirm
progress.
