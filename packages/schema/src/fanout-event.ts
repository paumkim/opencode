export * as FanoutEvent from "./fanout-event"

import { Schema } from "effect"
import { Event } from "./event"
import { Fanout } from "./fanout"
import { DateTimeUtcFromMillis, optional } from "./schema"
import { SessionID } from "./session-id"

/**
 * Fan-out events are aggregated on the fan-out GROUP, not on the parent
 * session. The parent's own event log is a transcript of what the parent said;
 * the crew's lifecycle is a separate durable aggregate so that a settled worker
 * survives the parent being compacted, moved, or replaced.
 */
const options = {
  durable: {
    aggregate: "groupID",
    version: 1,
  },
} as const

export const GroupOpened = Event.define({
  type: "fanout.group.opened",
  ...options,
  schema: {
    groupID: Fanout.GroupID,
    parentSessionID: SessionID,
    title: Schema.String,
    timestamp: DateTimeUtcFromMillis,
  },
})
export type GroupOpened = typeof GroupOpened.Type

export const WorkerJoined = Event.define({
  type: "fanout.worker.joined",
  ...options,
  schema: {
    groupID: Fanout.GroupID,
    parentSessionID: SessionID,
    workerID: Fanout.WorkerID,
    sessionID: SessionID,
    description: Schema.String,
    timestamp: DateTimeUtcFromMillis,
  },
})
export type WorkerJoined = typeof WorkerJoined.Type

export const WorkerSettled = Event.define({
  type: "fanout.worker.settled",
  ...options,
  schema: {
    groupID: Fanout.GroupID,
    parentSessionID: SessionID,
    workerID: Fanout.WorkerID,
    sessionID: SessionID,
    description: Schema.String,
    status: Schema.Literals(["done", "error"]),
    digest: optional(Schema.String),
    error: optional(Schema.String),
    timestamp: DateTimeUtcFromMillis,
  },
})
export type WorkerSettled = typeof WorkerSettled.Type

export const DurableDefinitions = Event.inventory(GroupOpened, WorkerJoined, WorkerSettled)
export const Definitions = DurableDefinitions
export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" })
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "FanoutDurableEvent" })
export type DurableEvent = typeof Durable.Type
