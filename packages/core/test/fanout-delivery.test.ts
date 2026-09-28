import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { FanoutDelivery } from "@opencode-ai/core/fanout/delivery"
import { FanoutLedger } from "@opencode-ai/core/fanout/ledger"
import { FanoutLifecycle } from "@opencode-ai/core/fanout/lifecycle"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Project } from "@opencode-ai/core/project"
import { testEffect } from "./lib/effect"
import { insertSession, sessionID, setup } from "./session-runner.fixture"

const wakes: string[] = []
const recorder = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: (id) => Effect.sync(() => void wakes.push(id)),
    interrupt: () => Effect.void,
  }),
)

// Built on demand, not with the test layer, so the boot sweep runs AFTER the
// ledger has been seeded: that is exactly what a process restart looks like.
const delivery = LayerNode.compile(FanoutDelivery.node, [[SessionExecution.node, recorder]])

/**
 * An execution service whose `wake` dies a fixed number of times, then works.
 *
 * `wake` is the one step of a push that is neither idempotent nor already
 * guarded: `deliver` is `.pipe(Effect.ignore)`d and the ledger reads `orDie` on
 * a query that cannot fail, but a failure raised here reaches the subscriber
 * fiber unhandled.
 */
let diesLeft = 0
const flaky = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: (id) =>
      Effect.suspend(() => {
        if (diesLeft > 0) {
          diesLeft--
          return Effect.die("wake exploded")
        }
        return Effect.sync(() => void wakes.push(id))
      }),
    interrupt: () => Effect.void,
  }),
)

const flakyDelivery = LayerNode.compile(FanoutDelivery.node, [[SessionExecution.node, flaky]])

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

const seed = Effect.gen(function* () {
  yield* setup
  wakes.length = 0
  const { db } = yield* Database.Service
  yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).run().pipe(Effect.orDie)
  yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, sessionID)).run().pipe(Effect.orDie)
  yield* insertSession(sessionID)
  const events = yield* EventV2.Service
  const group = yield* FanoutLifecycle.open(db, events, { parentSessionID: sessionID, title: "audit" })
  const child = SessionV2.ID.make("ses_fanout_delivery_child")
  const row: typeof SessionTable.$inferInsert = {
    id: child,
    project_id: Project.ID.global,
    slug: child,
    directory: "/project",
    title: "child",
    version: "test",
  }
  yield* db.insert(SessionTable).values(row).onConflictDoNothing().run().pipe(Effect.orDie)
  const worker = yield* FanoutLifecycle.join(db, events, {
    groupID: group.id,
    parentSessionID: sessionID,
    sessionID: child,
    description: "job 0",
  })
  return { db, worker, group }
})

const inbox = Effect.fn(function* () {
  const { db } = yield* Database.Service
  return yield* db
    .select({ id: SessionInputTable.id, delivery: SessionInputTable.delivery, prompt: SessionInputTable.prompt })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, sessionID))
    .all()
    .pipe(Effect.orDie)
})

/**
 * Waits for a published condition rather than a fixed sleep.
 *
 * A settled worker's digest reaches the parent through a live subscription, so
 * the test's next turn races the subscriber's. Sleeping for a guessed interval
 * would make this pass or fail by machine speed; polling a predicate that the
 * subscription itself changes is the signal worth waiting on.
 */
const untilSized = (want: number) =>
  Effect.fn("untilSized")(function* (what: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const size = (yield* inbox()).length
      if (size === want) return size
      if (size > want) return yield* Effect.die(`inbox grew past ${want} while waiting for ${what}`)
      yield* Effect.sleep(10)
    }
    return yield* Effect.die(`timed out waiting for ${want} inbox entries`)
  })

describe("FanoutDelivery", () => {
  it.live("pushes a result the previous process settled but never delivered", () =>
    Effect.gen(function* () {
      const { db, worker } = yield* seed
      const events = yield* EventV2.Service
      // The previous process recorded the digest and then exited before the
      // subscriber that would have pushed it existed.
      yield* FanoutLifecycle.settle(db, events, { workerID: worker.id, status: "done", digest: "Recovered digest." })
      expect(yield* inbox()).toEqual([])
      expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 1, live: 0, unclaimed: 1 })

      yield* Effect.provide(Effect.void, delivery).pipe(Effect.scoped)

      const delivered = yield* inbox()
      expect(delivered).toHaveLength(1)
      expect(delivered[0].delivery).toBe("steer")
      expect(JSON.stringify(delivered[0].prompt)).toContain("Recovered digest.")
      expect(wakes).toEqual([sessionID])
      expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 1, live: 0, unclaimed: 0 })
    }),
  )

  it.live("does not re-push a result it already delivered", () =>
    Effect.gen(function* () {
      const { db, worker } = yield* seed
      const events = yield* EventV2.Service
      yield* FanoutLifecycle.settle(db, events, { workerID: worker.id, status: "done", digest: "Once only." })

      yield* Effect.provide(Effect.void, delivery).pipe(Effect.scoped)
      yield* Effect.provide(Effect.void, delivery).pipe(Effect.scoped)

      // The second boot finds nothing unclaimed, so it neither re-pushes nor
      // wakes a parent that has nothing new to hear.
      expect(yield* inbox()).toHaveLength(1)
      expect(wakes).toEqual([sessionID])
    }),
  )

  it.live("keeps delivering after one push dies, instead of losing the rest of the crew", () =>
    Effect.provide(
      Effect.gen(function* () {
        const { db, group, worker: first } = yield* seed
        const events = yield* EventV2.Service
        const second = SessionV2.ID.make("ses_fanout_delivery_second")
        const row: typeof SessionTable.$inferInsert = {
          id: second,
          project_id: Project.ID.global,
          slug: second,
          directory: "/project",
          title: "second child",
          version: "test",
        }
        yield* db.insert(SessionTable).values(row).onConflictDoNothing().run().pipe(Effect.orDie)
        const other = yield* FanoutLifecycle.join(db, events, {
          groupID: group.id,
          parentSessionID: sessionID,
          sessionID: second,
          description: "job 1",
        })

        // Exactly one wake fails, and it fails AFTER the first digest has been
        // admitted, so the first delivery is not what the assertion rests on.
        diesLeft = 1

        yield* FanoutLifecycle.settle(db, events, { workerID: first.id, status: "done", digest: "First digest." })
        expect(yield* untilSized(1)("the first digest")).toBe(1)

        // The subscriber is the only thing that can deliver this one: the boot
        // sweep already ran when the layer was built. A subscriber that died on
        // the first push would leave this digest in the ledger for good.
        yield* FanoutLifecycle.settle(db, events, { workerID: other.id, status: "done", digest: "Second digest." })
        expect(yield* untilSized(2)("the digest after the failed push")).toBe(2)

        const delivered = yield* inbox()
        expect(JSON.stringify(delivered[1].prompt)).toContain("Second digest.")
        expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 1, live: 0, unclaimed: 0 })
      }),
      flakyDelivery,
    ),
  )
})
