---
name: memory
description: >
  The memory loop handles experience encoding, storage, and retrieval. It encodes
  sensorimotor observations and planning outcomes into structured memories,
  organizes them into working and long-term stores, indexes them for fast
  retrieval, and applies forgetting mechanisms to decay unused memories. Trigger
  keywords: memory, experience, recall, path tracking, map building, spatial
  memory, episodic memory, working memory, long-term memory.
---

# Memory Loop

## Purpose

The memory loop is the **experience layer** of the autonomous robotics framework.
It transforms raw observations and outcomes from other loops into structured,
retrievable knowledge. Where sensorimotor reacts to the present and planning
anticipates the future, memory ensures that what the robot has experienced is not
lost — it is encoded, indexed, and made available for future recall.

The core cycle is: **observe → encode → store → index → retrieve → apply**.

## Inputs

- **Sensorimotor observations** — streams of (state, action, outcome) tuples,
  prediction errors, and unexpected events captured during execution.
- **Planning waypoints** — trajectories, task graphs, and sub-goal sequences
  that succeeded or failed, along with their cost and risk assessments.
- **Learning outcomes** — updated policy parameters, new skill definitions,
  and generalization results from the learning loop.
- **Error-correction logs** — anomaly classifications, recovery actions taken,
  and root-cause attributions for failures.

## Processing

Each memory cycle performs five stages:

1. **Encoding** — filter relevant information from incoming data streams.
   Apply attention-weighted saliency to determine which observations are worth
   storing. Compress high-dimensional sensor data into compact feature
   representations (e.g., spatial landmarks, object poses, action outcomes).
2. **Storage** — organize encoded memories into two tiers:
   - **Working memory**: a bounded-capacity buffer of recent, high-priority
     memories (current task context, active spatial map, immediate goals).
   - **Long-term memory**: a persistent store of episodic traces and semantic
     knowledge (past missions, learned cost models, environmental maps).
3. **Indexing** — assign retrieval keys to each memory based on context
   (location, task type, object category, temporal proximity). Build spatial
   and semantic indexes for fast lookup.
4. **Retrieval** — query the memory store by current context. Use similarity
   search (e.g., nearest-neighbor in feature space) to find relevant past
   experiences. Apply a retrieval threshold to filter out low-confidence matches.
5. **Forgetting** — decay memories that have not been accessed within a
   configurable time window. Remove low-utility memories to free storage and
   prevent interference from outdated information.

## Outputs

- **Retrieved memories** — episodic traces and semantic knowledge relevant to
  the current context, returned to planning, learning, and error-correction.
- **Spatial maps** — accumulated environmental layout (obstacle positions,
  navigable paths, object locations) built from path tracking over time.
- **Behavioral patterns** — recurring action sequences and their outcomes,
  extracted from episodic traces and stored as reusable templates.
- **Learned associations** — semantic links between contexts, actions, and
  outcomes (e.g., "this object type is fragile", "this surface is slippery").

## Loop Cycle

```
observe → encode → store → index → retrieve → apply
```

| Stage | Description |
|-------|-------------|
| **observe** | Receive data streams from sensorimotor, planning, learning, and error-correction. |
| **encode** | Filter relevant information, compress into compact feature representations. |
| **store** | Write encoded memories into working memory (bounded) or long-term memory (persistent). |
| **index** | Assign retrieval keys, build spatial and semantic indexes for fast lookup. |
| **retrieve** | Query memory store by current context, return relevant past experiences. |
| **apply** | Deliver retrieved memories to requesting loops for planning, learning, and error-correction. |

## Templates

The memory loop selects a template based on the type of memory operation:

| Template | Use Case | Characteristics |
|----------|----------|-----------------|
| **Predictor** (`predictor-template`) | Retrieval scoring | Uses a learned similarity model to score and rank candidate memories during retrieval. The model is trained on past retrieval success — memories that led to good outcomes are upweighted. Best for context-sensitive recall where exact matches are rare. |
| **FSM** (`fsm-template`) | Memory state transitions | Manages the lifecycle of a memory through discrete states: `ENCODING → WORKING → CONSOLIDATED → FORGOTTEN`. Transitions are triggered by access frequency, age, and utility. Best for structured memory management with clear lifecycle rules. |
| **RL** (`rl-template`) | Experience replay | Selects which memories to replay during learning based on a learned value function. Memories that produced high prediction error or surprising outcomes are prioritized for replay. Best for improving learning efficiency through targeted experience replay. |

## Integration

The memory loop is a **cross-cutting layer** that connects to all other loops:

- **Meta-control** (upstream): Provides historical context for task decomposition
  and loop selection. When meta-control encounters a similar project, memory
  retrieves prior successful loop combinations and recommends them. Memory also
  stores meta-control's own decisions and outcomes for future reference.
- **Sensorimotor** (sideways): Receives priors for expected sensory states (e.g.,
  "this surface is slippery") to improve prediction accuracy. Streams
  (state, action, outcome) tuples for encoding into episodic memory.
- **Planning** (sideways): Supplies spatial maps, prior cost models, and
  historical plan outcomes. When planning encounters a known sub-goal, memory
  retrieves the previously successful plan. Planning also receives updated
  cost models from learning via memory.
- **Learning** (sideways): Provides episodic traces for experience replay and
  historical context for reward shaping. Stores learned policy parameters and
  new skill definitions as semantic knowledge.
- **Error-correction** (sideways): Stores failure patterns and recovery outcomes.
  When error-correction encounters a known anomaly type, memory retrieves the
  previously successful recovery action.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `working_memory_capacity` | 100 | Maximum number of memories retained in working memory |
| `long_term_retention_threshold` | 0.5 | Minimum utility score for a memory to be consolidated into long-term storage |
| `decay_rate` | 0.01 | Fraction of unused memories forgotten per cycle |
| `retrieval_threshold` | 0.7 | Minimum similarity score for a memory to be returned during retrieval |
| `map_resolution` | 0.05 | Spatial resolution (meters per cell) for accumulated spatial maps |

## Example

**Task**: A mobile robot explores an unknown maze and must remember dead-ends
and successful paths to navigate efficiently on future runs.

1. **observe**: As the robot moves through the maze, sensorimotor streams
   (pose, LiDAR scan, action taken) tuples. Planning provides the current
   waypoint sequence. Error-correction logs when the robot hits a dead-end.
2. **encode**: The memory loop filters each observation, extracting key features:
   wall positions, corridor widths, junction types. Dead-end encounters are
   flagged as high-saliency events.
3. **store**: Working memory holds the current maze segment being explored.
   Successful path segments are consolidated into long-term memory with a
   utility score based on how often they were traversed without failure.
   Dead-end locations are stored with negative utility.
4. **index**: Each memory is tagged with spatial coordinates (grid cell),
   junction type (T-intersection, dead-end, corridor), and traversal outcome
   (success, failure). A spatial index maps grid cells to stored memories.
5. **retrieve**: On a future run, when the robot approaches a T-intersection
   at coordinates (3.2, 4.1), memory retrieves the stored experience:
   "turning left from this junction leads to a dead-end after 2.3 meters;
   turning right leads to the goal in 5.1 meters." The retrieval score is
   0.85, above the `retrieval_threshold` of 0.7.
6. **apply**: The retrieved memory is delivered to planning, which selects the
   right turn. The robot reaches the goal 30% faster than on the first run,
   having avoided the known dead-end.

Over multiple runs, the robot's spatial map becomes increasingly complete,
and the memory loop's forgetting mechanism gradually decays low-utility
memories (e.g., construction zones that no longer exist), keeping the map
current.
