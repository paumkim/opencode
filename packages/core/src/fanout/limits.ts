export * as FanoutLimits from "./limits"

import { Schema } from "effect"
import { Fanout } from "@opencode-ai/schema/fanout"

/**
 * Fan-out breadth caps.
 *
 * Three groups is the point at which a parent stops being able to reason about
 * its own crew, and four workers per group is where "fanned out" turns into
 * "unreadable". Both are enforced against the durable ledger at spawn time, so
 * they hold across turns, restarts, and concurrent tool calls in one step --
 * they are not a number the model is asked to respect.
 */
export const caps = Fanout.Caps.make({ maxGroups: 3, maxWorkersPerGroup: 4 })

export class GroupLimitExceeded extends Schema.TaggedErrorClass<GroupLimitExceeded>()("Fanout.GroupLimitExceeded", {
  limit: Schema.Int,
  live: Schema.Int,
}) {
  override get message() {
    return `Fan-out is full: ${this.live} of ${this.limit} fan-out groups are still live. Wait for a group to finish, or check the fan-out cursor for unclaimed results before spawning again.`
  }
}

export class WorkerLimitExceeded extends Schema.TaggedErrorClass<WorkerLimitExceeded>()("Fanout.WorkerLimitExceeded", {
  limit: Schema.Int,
  live: Schema.Int,
}) {
  override get message() {
    return `Fan-out group is full: ${this.live} of ${this.limit} workers already belong to this group. Split the work into another group, or wait for a worker to finish.`
  }
}

export type Error = GroupLimitExceeded | WorkerLimitExceeded
