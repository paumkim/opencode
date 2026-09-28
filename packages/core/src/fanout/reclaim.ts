export * as FanoutReclaim from "./reclaim"

import { Effect } from "effect"
import type { BackgroundJob } from "../background-job"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionSchema } from "../session/schema"
import { FanoutDigest } from "./digest"
import { FanoutLedger } from "./ledger"
import { FanoutLifecycle } from "./lifecycle"

/**
 * Settles workers the ledger still calls live but that nothing is running any
 * more -- a restart, a closed location, a killed fiber -- from the child
 * session's own durable record.
 *
 * Without this a lost crew holds a cap slot forever and the parent's cursor
 * reports work that no longer exists. It runs before new work competes for a
 * slot, so recovery is part of the same step that spends the cap rather than
 * something an operator has to remember to trigger.
 */
export const stranded = Effect.fn("FanoutReclaim.stranded")(function* (
  db: Database.Interface["db"],
  events: EventV2.Interface,
  background: BackgroundJob.Interface,
  parentSessionID: SessionSchema.ID,
) {
  const running = new Set((yield* background.list()).map((job) => job.id))
  const lost = (yield* FanoutLedger.live(db, parentSessionID)).filter((worker) => !running.has(worker.sessionID))
  for (const worker of lost) {
    const digest = yield* FanoutDigest.ofSession(db, worker.sessionID)
    yield* FanoutLifecycle.settle(db, events, {
      workerID: worker.id,
      status: digest ? "done" : "error",
      ...(digest ? { digest } : { error: "the worker was interrupted before it produced a result" }),
    }).pipe(Effect.ignore)
  }
  return lost.map((worker) => worker.id)
})
