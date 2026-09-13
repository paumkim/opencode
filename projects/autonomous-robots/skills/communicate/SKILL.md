---
name: communicate
description: >
  The communicate skill handles communication with humans and other agents. It
  generates messages, selects the appropriate modality (speech, gestures,
  visual signals), and delivers them to convey internal state, goals, and
  observations. Trigger keywords: communication, human-robot interaction,
  speech, language, dialogue, natural language, HRI, social signal, intent
  signaling, multimodal communication.
---

# Communicate Skill

## Purpose

Communicate with humans and other agents — convey internal state, goals, and
observations through speech, gestures, and visual signals. The communicate
skill is the **social interface layer** invoked by the meta-control loop when
status reporting, intent signaling, or human interaction is required. It takes
internal state and task context, generates appropriate messages, selects the
best communication modality, and delivers the message to the recipient.

## Inputs

- **Internal state** from `meta-control` — current task status, battery level,
  error conditions, and confidence in ongoing operations.
- **Goals** from `planning` — active sub-goals, task progress, and upcoming
  actions that the robot intends to perform.
- **Observations** from `attention` — salient stimuli detected in the
  environment, including objects of interest, obstacles, and human presence.

## Processing

Each communicate cycle performs four stages:

1. **Message generation** — compose a message from the internal state, goals,
   and observations. Determine the semantic content (what to say) and the
   urgency level (how important it is to communicate now).
2. **Modality selection** — choose the appropriate output channel (speech,
   gestures, visual signals) based on the recipient, environment, and message
   content. Speech is best for detailed information; gestures for spatial
   references; visual signals for status indicators.
3. **Delivery** — produce the message through the selected modality. This may
   involve text-to-speech synthesis, motor commands for gestures, or LED/light
   patterns for visual signals.
4. **Reception** — monitor the recipient's response (verbal acknowledgment,
   gesture, visual attention) to confirm the message was received and
   understood.

## Outputs

- **Speech** — synthesized audio output conveying information, requests, or
  status updates to human users.
- **Gestures** — motor commands for arm/hand movements that convey spatial
  references, intent, or emotional state.
- **Visual signals** — LED patterns, screen displays, or light indicators that
  convey status, attention direction, or emotional state.

## Loop Cycle

```
assess → generate → select → deliver → receive → adapt
```

| Stage | Description |
|-------|-------------|
| **assess** | Evaluate the urgency and relevance of information to communicate. |
| **generate** | Compose the message content from internal state, goals, and observations. |
| **select** | Choose the appropriate output modality (speech, gesture, visual). |
| **deliver** | Produce the message through the selected modality. |
| **receive** | Monitor the recipient's response to confirm message reception. |
| **adapt** | Adjust future communication based on the recipient's response and engagement. |

## Templates

The communicate skill selects a template based on the structure of the
communication task:

| Template | Use Case | Characteristics |
|----------|----------|-----------------|
| **FSM** (`fsm-template`) | Communication state management | Manages the lifecycle of a communication exchange through discrete states (`IDLE → ASSESSING → GENERATING → DELIVERING → RECEIVING → ADAPTING`). Best for structured interactions with clear phases like status reporting. |
| **Predictor** (`predictor-template`) | Response prediction | Uses a learned or analytical model to predict the recipient's likely response to a message. The model is trained on past interaction data. Best for anticipating human reactions and adapting message content proactively. |
| **RL** (`rl-template`) | Dialogue policy learning | Reinforcement learning agent that learns an optimal dialogue policy — what to say, when to say it, and how to respond to the recipient. Rewarded for successful communication (acknowledgment, task completion) and penalized for miscommunication. Best for complex, open-ended interactions. |

## Integration

The communicate skill is invoked by the **meta-control loop** and connects to
the broader framework as follows:

- **Meta-control** (upstream): Receives status reports, intent signals, and
  progress updates from meta-control. Reports communication outcomes (message
  delivered, recipient acknowledged, feedback received). When urgent
  information arises, signals meta-control to interrupt current tasks.
- **Social loop** (coordinates): Coordinates with the social loop for
  multi-agent communication, ensuring consistent messaging across multiple
  robots or agents.
- **Memory** (context): Retrieves historical context about the recipient
  (preferred communication style, past interactions, relationship history) to
  personalize messages. Stores successful communication patterns for future
  reuse.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `message_urgency` | 0.5 | Threshold above which a message is communicated immediately rather than queued. Range [0, 1]. |
| `modality_preference` | speech | Preferred output modality: `speech`, `gesture`, `visual`, or `multimodal`. |
| `response_timeout` | 5.0 s | Maximum time to wait for a recipient's response before proceeding. |

## Example

**Task**: A robot exploring a maze must report its progress to a human
supervisor.

1. **assess**: The robot has discovered 70% of the maze, found the red ball,
   and is navigating toward it. The urgency is moderate — the supervisor
   should know the ball was found but the robot is still working.
2. **generate**: The message is composed: "I have found the red ball at
   coordinates (3.2, 1.5). I am now navigating toward it. Estimated time to
   completion: 30 seconds."
3. **select**: The modality is selected as speech — the supervisor is in the
   same room and speech is the most efficient channel for this information.
4. **deliver**: The text-to-speech system produces the audio output through
   the robot's speaker.
5. **receive**: The robot monitors the supervisor's response — a verbal
   "acknowledged" is detected by the microphone.
6. **adapt**: The robot notes that the supervisor responded positively and
   continues its task. If the supervisor had not responded within
   `response_timeout`, the robot would have repeated the message or switched
   to a visual signal (LED flash).

Throughout, the communicate skill retrieves context from memory (the
supervisor prefers concise updates) and stores the successful interaction
pattern for future use.
