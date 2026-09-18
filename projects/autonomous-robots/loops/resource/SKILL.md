---
name: resource
description: >
  Design specification for a proposed resource loop: resource arbitration and
  allocation. It would assess available system capacity, rank resource requests
  by priority, allocate compute, power, and bandwidth to competing loops,
  monitor utilization, and rebalance allocations when demand shifts. Not a
  runnable module. Trigger keywords: resource management, resource allocation,
  compute budget, bandwidth, scheduling, priority queuing, resource arbitration,
  load balancing, capacity planning, resource pooling.
---

# Resource Loop

## Current Status and Safety Boundary

**Design specification, not a runnable module.** All robot loops currently have
only `SKILL.md`; `src/` implements a generic software supervisory runtime, not
resource allocation policies. The grants, preemption, forecasting, and adaptive
scheduling below are proposed behavior, not implemented enforcement. Current
scheduling executes a supplied sequence, not a DAG or a priority allocator.

Rates and budgets are illustrative targets, **not latency, real-time, or minimum
allocation guarantees**. There is no hardware safety certification, actuator
enforcement, or persistence/resume. Physical operation would require independent,
always-on physical monitoring and protective controls outside this sequential JS
runtime; advisory resource decisions must not starve or disable those controls.
Hardware limits are immutable to learning and task priority; adaptive advisory
setpoints remain inside them. Learned allocation-policy deployment requires
validation, explicit operator approval, and a rollback plan. None of those
physical protections or deployment gates is implemented here.

## Purpose

The resource loop is the **arbitration layer** of the autonomous robotics
framework. While sensorimotor reacts to the present and planning anticipates
the future, resource ensures that every loop gets its fair share of the robot's
finite computational, power, and communication budget. It is the traffic
controller for the robot's internal economy: when planning demands heavy CPU for
trajectory optimization and sensorimotor needs low-latency processing for
obstacle avoidance, the resource loop decides who gets what, when, and for how
long.

The core cycle is: **assess → rank → allocate → monitor → rebalance → forecast**.

## Inputs

- **Resource requests** from all loops — each loop submits a request specifying
  its required CPU cycles, memory footprint, bandwidth, and latency constraints.
  Requests include a minimum viable allocation (below which the loop degrades)
  and a desired allocation (at which it operates optimally).
- **Available capacity** from `homeostasis` — the current system-wide budgets for
  CPU, memory, power, and network bandwidth, derived from real-time monitoring
  of battery level, thermal headroom, and hardware utilization. Homeostasis also
  provides capacity forecasts (e.g., "battery will last 12 more minutes at
  current draw").
- **Task priorities** from `meta-control` — the priority ranking of active
  sub-tasks and the loops serving them. A life-critical navigation task ranks
  higher than routine data logging. Meta-control also provides the current
  mission phase (exploration, execution, recovery) which biases allocation
  policies.
- **Historical utilization** from `memory` — past resource consumption patterns
  for each loop and task type, used to refine allocation predictions and detect
  anomalies (e.g., a loop consuming 3× its typical budget may indicate a
  runaway process).

## Processing

Each resource cycle performs six stages:

1. **Capacity assessment** — read the current system capacity from homeostasis.
   This includes total CPU budget (in cores or cycles), available memory,
   remaining power (in watt-hours), and network bandwidth. Each capacity metric
   is timestamped and validated against hardware limits.
2. **Priority ranking** — collect all pending resource requests from active
   loops and rank them by priority. Priority is computed from the task priority
   provided by meta-control, the loop's criticality (sensorimotor > planning >
   learning), and the urgency of the request (real-time deadlines, minimum
   viable thresholds). Requests are sorted into a priority queue.
3. **Allocation** — walk the priority queue and allocate capacity to each
   request in order. For each request, grant the minimum viable allocation
   first, then distribute remaining capacity to maximize overall utility. If
   total demand exceeds capacity, lower-priority requests are partially or fully
   denied.
4. **Monitoring** — track actual resource consumption against allocated budgets
   in real time. Each loop reports its utilization at the configured
   `monitor_rate`. Deviations from expected usage are flagged for rebalancing.
5. **Rebalancing** — when a loop's utilization deviates significantly from its
   allocation (e.g., planning finished its optimization early and freed CPU),
   or when a new high-priority request arrives, redistribute capacity. This may
   involve preempting a lower-priority loop's allocation and reallocating it.
6. **Forecast** — using the predictor template, project future capacity needs
   based on current task progress and historical patterns. Update the capacity
   forecast sent to homeostasis so it can adjust power and thermal management.

## Outputs

- **Resource grants** — allocation decisions sent to each loop, specifying the
  CPU budget, memory limit, bandwidth cap, and latency target it may use
  until the next rebalance cycle.
- **Scheduling decisions** — temporal ordering of loop execution when capacity is
  insufficient for simultaneous operation. Sent to meta-control for coordination.
- **Load shedding commands** — directives to lower-priority loops to reduce
  their resource consumption (e.g., "reduce sensorimotor sampling rate from
  100 Hz to 50 Hz", "pause learning exploration for 30 seconds"). Sent to the
  affected loops directly.
- **Capacity forecasts** — projected system capacity over the next prediction
  horizon, sent to homeostasis for power and thermal planning. Includes
  estimated time-to-capacity-exhaustion for each resource type.

## Loop Cycle

```
assess → rank → allocate → monitor → rebalance → forecast
```

| Stage | Description |
|-------|-------------|
| **assess** | Read current system capacity (CPU, memory, power, bandwidth) from homeostasis. |
| **rank** | Collect resource requests from all loops; sort by priority (task priority, loop criticality, urgency). |
| **allocate** | Walk the priority queue; grant minimum viable allocation first, then distribute remaining capacity. |
| **monitor** | Track actual utilization against allocated budgets in real time. |
| **rebalance** | Redistribute capacity when utilization deviates or new high-priority requests arrive. |
| **forecast** | Project future capacity needs and update the forecast sent to homeostasis. |

## Templates

The resource loop selects a template based on the structure of the allocation
problem and the available models:

| Template | Use Case | Characteristics |
|----------|----------|-----------------|
| **FSM** (`fsm-template`) | Resource state management | Manages the lifecycle of a resource allocation through discrete states: `AVAILABLE → REQUESTED → ALLOCATED → OVERSUBSCRIBED → PREEMPTED → RELEASED`. Transitions are triggered by capacity changes, priority shifts, and deadline events. Best for well-structured allocation tasks with clear state transitions and deterministic policies. |
| **Predictor** (`predictor-template`) | Capacity forecasting | Uses a learned or analytical model to predict future resource demand based on current task progress, historical utilization patterns, and task context. Estimates time-to-capacity-exhaustion for each resource type and pre-emptively triggers rebalancing before a bottleneck is reached. Best for proactive allocation where early intervention prevents contention. |
| **RL** (`rl-template`) | Adaptive allocation | Learns an allocation policy through trial and reward — the policy is rewarded for maximizing overall system utility (task progress, deadline adherence) while penalizing resource starvation and excessive preemption. Adapts to changing workload patterns and discovers non-obvious allocation strategies. Best for complex, dynamic environments where optimal trade-offs are difficult to specify analytically. |

## Integration

The resource loop is a **cross-cutting layer** that connects to all other loops:

- **Meta-control** (upstream): Receives task priorities and mission phase context
  that bias allocation decisions. When resource cannot satisfy a high-priority
  request, it sends an interrupt to meta-control, which may re-sequence loops,
  defer non-critical sub-tasks, or request human intervention. Meta-control also
  receives scheduling decisions and capacity forecasts for mission-level planning.
- **Homeostasis** (upstream): Receives capacity forecasts and sends current
  system capacity (CPU, memory, power, bandwidth). When homeostasis detects
  that power or thermal headroom is shrinking, it reduces the capacity budget
  and the resource loop must rebalance allocations accordingly. Resource also
  receives capacity forecasts from homeostasis to inform its own predictions.
- **Sensorimotor** (downstream): Receives CPU and bandwidth grants that determine
  its sampling rate and processing pipeline depth. Sensorimotor reports actual
  utilization and may request emergency preemption when a real-time deadline is
  at risk. A future implementation would be required to preserve
  sensorimotor's minimum viable allocation for safety-critical
  perception-action cycles when capacity permits. If capacity is insufficient,
  it must deny or shed lower-priority work; if the minimum still cannot be met,
  it must reject or defer affected work and escalate the shortfall to meta-control.
  Physical protection must not depend on this allocator.
- **Planning** (downstream): Receives compute budget that determines the
  planning horizon and algorithm complexity (e.g., A* vs. RL exploration).
  Planning reports resource usage and may request additional budget for
  computationally expensive replanning. Resource may throttle planning's
  exploration budget when capacity is constrained.
- **Attention** (downstream): Receives bandwidth and CPU grants that determine
  the resolution and frequency of saliency scanning. Attention reports its
  processing load and may request priority preemption when a high-saliency
  stimulus is detected.
- **Learning** (downstream): Receives exploration budget and training compute
  allocation. Learning is the most preemptible loop — when capacity is tight,
  resource suspends learning exploration and defers training updates. Learning
  reports its utilization and may request additional budget for policy
  improvement.
- **Memory** (downstream): Receives I/O bandwidth and memory allocation for
  encoding, indexing, and retrieval operations. Memory reports its storage
  utilization and may request additional capacity for large episodic trace
  consolidation.
- **Error-correction** (downstream): Receives priority preemption rights — when
  error-correction detects a critical anomaly, it can request immediate
  resource preemption to ensure recovery actions have sufficient compute.
  A future implementation would be required to prioritize error-correction's
  minimum allocation during recovery, denying lower-priority requests first.
  If capacity still cannot meet that minimum, it must defer affected recovery
  work and escalate to meta-control; physical protection must remain independent
  of this allocator. These are design requirements, not implemented guarantees.
- **Social** (downstream): Receives bandwidth and CPU grants for human
  communication (speech synthesis, gesture generation). Social is preemptible
  during resource contention.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `monitor_rate` | 50 Hz | Frequency at which actual resource utilization is sampled from each loop |
| `cpu_budget` | 4 cores | Total CPU capacity available for allocation across all loops |
| `memory_budget` | 4 GB | Total memory available for allocation across all loops |
| `bandwidth_limit` | 100 MB/s | Total network bandwidth available for allocation |
| `power_budget` | 50 W | Total power budget derived from homeostasis (battery level, thermal headroom) |
| `priority_weights` | `{task: 0.5, criticality: 0.3, urgency: 0.2}` | Relative weights for computing request priority scores |
| `rebalance_interval` | 0.5s | Maximum time between rebalancing cycles |
| `preemption_grace` | 0.1s | Minimum notice period before a loop's allocation is reduced or revoked |
| `min_viable_threshold` | 0.3 | Fraction of desired allocation below which a loop is considered starved |
| `forecast_horizon` | 10s | Time horizon for capacity demand predictions |

## Example (Conceptual)

**Task**: A mobile robot is navigating through a maze using a planned waypoint
sequence. It must simultaneously run sensorimotor (obstacle avoidance at 100 Hz),
planning (trajectory optimization), and learning (policy refinement from recent
experience).

1. **assess**: The resource loop reads system capacity from homeostasis: 4 CPU
   cores available, 4 GB memory, 50 W power budget. Battery is at 60% with an
   estimated 20 minutes of operation remaining.
2. **rank**: Three resource requests arrive:
   - Sensorimotor: 2 cores, 1 GB memory, 100 Hz latency target (criticality:
     high, task priority: 0.9)
   - Planning: 1.5 cores, 1.5 GB memory, 10 Hz latency (criticality: medium,
     task priority: 0.7)
   - Learning: 1 core, 1 GB memory, best-effort (criticality: low, task
     priority: 0.3)
   Priority ranking: sensorimotor (0.9) > planning (0.7) > learning (0.3).
3. **allocate**: The resource loop grants sensorimotor its full request (2 cores,
   1 GB). Planning receives 1.5 cores and 1.5 GB. Learning receives 0.5 cores
   and 1 GB — below its desired allocation but above its minimum viable
   threshold. The four cores are now fully allocated (2 + 1.5 + 0.5).
4. **monitor**: At 50 Hz, the resource loop tracks utilization. Sensorimotor is
   using 1.8 cores (within allocation). Planning is using 1.2 cores (under
   allocation — trajectory optimization finished early). Learning is using 0.5
   cores (at allocation limit).
5. **rebalance**: Planning's early completion frees 0.3 cores. The resource loop
   reallocates 0.3 cores to learning, bringing it to 0.8 cores. A new high-priority
   request arrives from attention (a novel stimulus detected) — the resource loop
   preempts 0.2 cores from learning to satisfy attention's minimum viable
   allocation.
6. **forecast**: Using the predictor template, the resource loop projects that
   the current allocation will sustain the robot for 18 minutes (slightly less
   than homeostasis's 20-minute estimate, accounting for the additional attention
   load). This forecast is sent to homeostasis, which confirms the robot can
   complete the maze within the power budget.

Throughout this conceptual example, the proposed resource loop would continue
its assess → rank → allocate → monitor → rebalance → forecast cycle, aiming to
give sensorimotor sufficient compute for real-time obstacle avoidance while
maximizing the utility of planning and learning within the available capacity.
The 50 Hz monitoring and per-loop grants are illustrative targets, not
implemented behavior or latency guarantees.
