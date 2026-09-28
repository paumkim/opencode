export * as FanoutContext from "./context"

import { Effect, Schema } from "effect"
import { Fanout } from "@opencode-ai/schema/fanout"
import type { Database } from "../database/database"
import { SessionSchema } from "../session/schema"
import { SystemContext } from "../system-context/index"
import { FanoutLedger } from "./ledger"

type DatabaseService = Database.Interface["db"]

/**
 * The parent's per-turn view of its own crew.
 *
 * This is the whole cost of remembering a fan-out: three integers, re-read from
 * the durable ledger once per turn and rendered into the system context only
 * when they change. An unchanged crew reconciles to `Unchanged`, so it costs
 * nothing; a session that has never fanned out contributes no source at all.
 */
export const key = SystemContext.Key.make("fanout/ledger")

export const load = Effect.fn("FanoutContext.load")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const cursor = yield* FanoutLedger.cursor(db, sessionID)
  if (cursor.groups === 0) return SystemContext.empty
  return SystemContext.make({
    key,
    codec: Schema.toCodecJson(Fanout.Cursor),
    load: Effect.succeed(cursor),
    baseline: (cursor) => baseline(cursor),
    update: (_previous, cursor) => `Your fan-out ledger changed. Right now: ${describe(cursor)}.`,
  })
})

/**
 * The one sentence that tells a parent what its crew is doing.
 *
 * Shared by the v2 system-context source and the v1 system prompt so the two
 * protocols cannot drift into describing the same ledger differently.
 */
export const describe = (cursor: Fanout.Cursor) =>
  `${cursor.live} worker(s) live across ${cursor.groups} group(s), ${cursor.unclaimed} finished result(s) not yet delivered`

export const baseline = (cursor: Fanout.Cursor) =>
  `Your fan-out ledger is durable and survives compaction. Right now: ${describe(cursor)}.`