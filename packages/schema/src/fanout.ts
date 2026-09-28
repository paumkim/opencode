export * as Fanout from "./fanout"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { NonNegativeInt, PositiveInt, statics } from "./schema"

export const GroupID = Schema.String.check(Schema.isStartsWith("fng")).pipe(
  Schema.brand("Fanout.GroupID"),
  statics((schema) => ({ create: () => schema.make("fng_" + ascending()) })),
)
export type GroupID = typeof GroupID.Type

export const WorkerID = Schema.String.check(Schema.isStartsWith("fnw")).pipe(
  Schema.brand("Fanout.WorkerID"),
  statics((schema) => ({ create: () => schema.make("fnw_" + ascending()) })),
)
export type WorkerID = typeof WorkerID.Type

/** A group stays `live` while any of its workers is still running. */
export const GroupStatus = Schema.Literals(["live", "settled"])
export type GroupStatus = typeof GroupStatus.Type

export const WorkerStatus = Schema.Literals(["live", "done", "error"])
export type WorkerStatus = typeof WorkerStatus.Type

/**
 * The per-turn fan-out cursor. This is the parent's entire view of its crew and it
 * is deliberately tiny: three integers cost a handful of tokens and only change
 * when the ledger changes, so an unchanged fan-out costs nothing per turn.
 */
export const Cursor = Schema.Struct({
  groups: NonNegativeInt,
  live: NonNegativeInt,
  unclaimed: NonNegativeInt,
}).annotate({ identifier: "Fanout.Cursor" })
export interface Cursor extends Schema.Schema.Type<typeof Cursor> {}

/**
 * Fan-out breadth caps. Both are hard limits enforced at spawn time against the
 * durable ledger, not advisory hints the model can talk its way past.
 */
export const Caps = Schema.Struct({
  maxGroups: PositiveInt,
  maxWorkersPerGroup: PositiveInt,
}).annotate({ identifier: "Fanout.Caps" })
export interface Caps extends Schema.Schema.Type<typeof Caps> {}
