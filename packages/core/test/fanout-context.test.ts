import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import {
  it,
  setup,
  sessionID,
  State,
  Database,
  EventV2,
  Prompt,
  SessionV2,
  SystemContext,
  EventTable,
  fragmentFixture,
  userTexts,
  systemTexts,
  type LLMRequest,
} from "./session-runner.fixture"
import { FanoutContext } from "@opencode-ai/core/fanout/context"
import { FanoutLifecycle } from "@opencode-ai/core/fanout/lifecycle"
import { FanoutLedger } from "@opencode-ai/core/fanout/ledger"
import { FanoutGroupTable, FanoutWorkerTable } from "@opencode-ai/core/fanout/sql"

const answer = () => fragmentFixture("text", "text-answer", ["Answer"]).completeEvents

const reset = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.delete(FanoutWorkerTable).where(eq(FanoutWorkerTable.parent_session_id, sessionID)).run().pipe(Effect.orDie)
  yield* db.delete(FanoutGroupTable).where(eq(FanoutGroupTable.parent_session_id, sessionID)).run().pipe(Effect.orDie)
})

const crew = Effect.fn(function* (live: number) {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const group = yield* FanoutLifecycle.open(db, events, { parentSessionID: sessionID, title: "audit" })
  const session = yield* SessionV2.Service
  const workers = []
  for (let index = 0; index < live; index++) {
    const child = yield* session.create({ location: { directory: "/project" } as never })
    workers.push(
      yield* FanoutLifecycle.join(db, events, {
        groupID: group.id,
        parentSessionID: sessionID,
        sessionID: child.id,
        description: `job ${index}`,
      }),
    )
  }
  return { group, workers }
})

const system = (request: LLMRequest | undefined) => (request?.system ?? []).map((part) => part.text)

const turn = (prompt: string) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    State.response = answer()
    State.requests.length = 0
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    yield* session.resume(sessionID)
    return State.requests.at(-1)
  })

describe("FanoutContext", () => {
  it.effect("contributes no source at all to a session that has never fanned out", () =>
    Effect.gen(function* () {
      yield* setup
      yield* reset
      const { db } = yield* Database.Service
      const context = yield* FanoutContext.load(db, sessionID)
      const generation = yield* SystemContext.initialize(context)
      expect(generation.baseline).toBe("")
      expect(generation.snapshot).toEqual({})
      // Nothing is added to the system prompt, so a session with no crew pays zero.
      const request = yield* turn("hello")
      expect(system(request!)).toEqual(["Initial context"])
    }),
  )

  it.effect("shows the parent its crew in the system baseline and costs nothing while unchanged", () =>
    Effect.gen(function* () {
      yield* setup
      yield* reset
      yield* crew(2)

      const first = yield* turn("start")
      const baseline = system(first!).join("\n")
      expect(baseline).toContain("Your fan-out ledger is durable and survives compaction")
      expect(baseline).toContain("2 worker(s) live across 1 group(s), 0 finished result(s) not yet delivered")
      expect(userTexts(first!)).toEqual(["start"])

      const second = yield* turn("again")
      // Unchanged cursor, unchanged baseline: the crew is remembered for free.
      expect(system(second!).join("\n")).toBe(baseline)

      const { db } = yield* Database.Service
      const updates = yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(eq(EventTable.type, "session.next.context.updated.1"))
        .all()
        .pipe(Effect.orDie)
      expect(updates).toHaveLength(0)
    }),
  )

  it.effect("re-renders the cursor the moment the ledger moves", () =>
    Effect.gen(function* () {
      yield* setup
      yield* reset
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const { workers } = yield* crew(2)
      const before = system(yield* turn("start")).join("\n")

      yield* FanoutLifecycle.settle(db, events, { workerID: workers[0].id, status: "done", digest: "one" })
      yield* FanoutLifecycle.settle(db, events, { workerID: workers[1].id, status: "done", digest: "two" })
      expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 1, live: 0, unclaimed: 2 })

      const next = yield* turn("check")
      // The baseline is immutable; the change arrives as a system message.
      expect(system(next!).join("\n")).toBe(before)
      const update = systemTexts(next!).join("\n")
      expect(update).toContain("Your fan-out ledger changed")
      expect(update).toContain("0 worker(s) live across 1 group(s), 2 finished result(s) not yet delivered")

      const published = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, "session.next.context.updated.1"))
        .all()
        .pipe(Effect.orDie)
      expect(published).toHaveLength(1)
      expect(JSON.stringify(published[0]?.data)).toContain("2 finished result(s) not yet delivered")
    }),
  )

  it.effect("keeps the cursor out of a worker session's own context", () =>
    Effect.gen(function* () {
      yield* setup
      yield* reset
      const { db } = yield* Database.Service
      const { group, workers } = yield* crew(1)
      const context = yield* FanoutContext.load(db, workers[0].sessionID)
      const generation = yield* SystemContext.initialize(context)
      expect(generation.baseline).toBe("")
      // The worker's ledger identity is the group's, not the parent's crew view.
      expect(yield* FanoutLedger.findGroup(db, group.id)).toMatchObject({ parentSessionID: sessionID })
    }),
  )
})
