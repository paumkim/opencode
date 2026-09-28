export * as FanoutDelivery from "./delivery"

import { Cause, Effect, Layer, Stream } from "effect"
import { Fanout } from "@opencode-ai/schema/fanout"
import { FanoutEvent } from "@opencode-ai/schema/fanout-event"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { SessionExecution } from "../session/execution"
import { FanoutLedger } from "./ledger"
import { FanoutLifecycle } from "./lifecycle"

/**
 * Pushes a settled worker's digest to its parent, and nothing else does.
 *
 * This is the "completion is a push" half of fan-out, and it lives outside the
 * Location graph on purpose: waking a parent is app-level routing, so the
 * tool that spawns a crew cannot be the thing that reports back. Everything
 * that can settle a worker -- the background supervisor, a reclaim sweep --
 * only has to record the digest and publish the event; delivery follows.
 *
 * Delivery is a `steer` admission, so the parent's runner promotes it at a
 * turn boundary. The digest is already durable in the ledger when the event
 * fires, so a result is delayed by at most a turn and never lost.
 */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const execution = yield* SessionExecution.Service

    const push = Effect.fn("FanoutDelivery.push")(function* (workerID: Fanout.WorkerID) {
      const worker = yield* FanoutLedger.findWorker(db, workerID)
      if (!worker) return
      yield* FanoutLifecycle.deliver(db, events, worker).pipe(Effect.ignore)
      // Registering the wake is what gives an idle parent a turn. A parent that
      // is mid-sentence already has one, and the runner promotes the steer at
      // its next turn boundary instead.
      yield* execution.wake(worker.parentSessionID)
    })

    // Two levels of containment, because they buy different things.
    //
    // Per event: one worker's delivery failing is that worker's problem, and it
    // is almost always recoverable -- the digest is already durable in the
    // ledger, and a claim only happens after the admit, so whatever was not
    // pushed yet is still there for a later sweep. Letting that failure escape
    // would end the stream, and nothing ever restarts the subscription, so one
    // bad wake would strand every later finished worker's result for the life
    // of the process.
    //
    // Around the stream, and BEFORE the fork: `catchCause` placed after
    // `forkScoped` can only ever see a failure to *start* the fiber. Once
    // forked the subscription runs in its own fiber, so a failure of the bus
    // itself escapes the handler entirely and surfaces as an unhandled fiber
    // defect instead of a log line.
    yield* events.subscribe(FanoutEvent.WorkerSettled).pipe(
      Stream.mapEffect((event) =>
        push(event.data.workerID).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Fan-out delivery failed for one worker", {
              workerID: event.data.workerID,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      ),
      Stream.runDrain,
      Effect.catchCause((cause) => Effect.logError("Fan-out delivery subscription stopped", cause)),
      Effect.forkScoped,
    )

    // A restart loses live subscribers but not the ledger, so anything the
    // previous process finished and never got to push is swept up on boot.
    const recovered = yield* FanoutLedger.parentsWithUnclaimed(db)
    for (const parentSessionID of recovered) {
      for (const worker of yield* FanoutLedger.unclaimed(db, parentSessionID)) yield* push(worker.id)
    }
  }),
)

export const node = makeGlobalNode({
  name: "fanout-delivery",
  layer,
  deps: [Database.node, EventV2.node, SessionExecution.node],
})
