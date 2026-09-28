import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import {
  it,
  setup,
  sessionID,
  State,
  DateTime,
  Database,
  EventV2,
  Prompt,
  SessionEvent,
  SessionMessage,
  SessionV2,
  SystemContext,
  EventTable,
  SessionContextEpochTable,
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

/**
 * A manual compaction of the parent, published the way `SessionCompaction`
 * publishes an automatic one. Nothing else about the session changes: the crew
 * is still in the ledger, the children are still running, and the only new
 * thing is a summary in place of the transcript.
 */
const compact = Effect.fn(function* (summary: string) {
  const events = yield* EventV2.Service
  const messageID = SessionMessage.ID.create()
  yield* events.publish(SessionEvent.Compaction.Started, {
    sessionID,
    messageID,
    timestamp: yield* DateTime.now,
    reason: "manual",
  })
  const ended = yield* events.publish(SessionEvent.Compaction.Ended, {
    sessionID,
    messageID,
    timestamp: yield* DateTime.now,
    reason: "manual",
    text: summary,
    recent: "",
  })
  return ended.durable!.seq
})

const epoch = Effect.fn(function* () {
  const { db } = yield* Database.Service
  return yield* db
    .select()
    .from(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
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
      // The crew is three integers in the ledger, rendered into the baseline
      // the model actually sees. The proof that this is durable is the
      // compaction test below, not this sentence.
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

  it.effect("still names its live crew in the context a compaction rebuilds from scratch", () =>
    Effect.gen(function* () {
      yield* setup
      yield* reset
      const { db } = yield* Database.Service
      const { workers } = yield* crew(2)

      const before = yield* turn("start")
      expect(system(before!).join("\n")).toContain(
        "2 worker(s) live across 1 group(s), 0 finished result(s) not yet delivered",
      )
      const recorded = yield* epoch()
      expect(recorded?.baseline).toContain("2 worker(s) live across 1 group(s), 0 finished result(s) not yet delivered")

      // The summary is deliberately silent about the crew: a real summary
      // generated by a model is just as likely to drop it, and that is the
      // whole reason the cursor cannot live in the transcript.
      const compactionSeq = yield* compact("Earlier turns: the user asked for a build audit.")
      // The stored baseline predates the compaction, so the row read after the
      // turn below can only have been written by the rebuild.
      expect(recorded!.baseline_seq).toBeLessThan(compactionSeq)

      const after = yield* turn("what is left")

      // The transcript really is gone: the turn after a compaction is answered
      // from the summary, not from the messages that came before it, and that
      // summary never mentions the crew.
      expect(userTexts(after!).join("\n")).toContain("Earlier turns: the user asked for a build audit.")
      expect(userTexts(after!)).not.toContain("start")
      expect(userTexts(after!).join("\n")).not.toContain("worker(s) live")

      // THE POINT: the rebuilt context still carries the crew. If compaction
      // could make a parent forget its fan-out, this is the line that goes
      // missing, because the pre-compaction baseline was thrown away.
      expect(system(after!).join("\n")).toContain(
        "2 worker(s) live across 1 group(s), 0 finished result(s) not yet delivered",
      )
      expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 1, live: 2, unclaimed: 0 })
      expect((yield* FanoutLedger.findWorker(db, workers[0].id))?.status).toBe("live")

      // And the rebuilt baseline is what was persisted, not just what was sent:
      // the epoch was REPLACED at the compaction, not reconciled against it.
      const rebuilt = yield* epoch()
      expect(rebuilt?.baseline).toContain("2 worker(s) live across 1 group(s), 0 finished result(s) not yet delivered")
      expect(rebuilt?.baseline_seq).toBe(compactionSeq)
    }),
  )

  it.effect("still names an undelivered result in the context a compaction rebuilds", () =>
    Effect.gen(function* () {
      yield* setup
      yield* reset
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const { workers } = yield* crew(2)

      expect(system(yield* turn("start")).join("\n")).toContain(
        "2 worker(s) live across 1 group(s), 0 finished result(s) not yet delivered",
      )
      yield* FanoutLifecycle.settle(db, events, { workerID: workers[0].id, status: "done", digest: "one" })
      yield* FanoutLifecycle.settle(db, events, { workerID: workers[1].id, status: "done", digest: "two" })
      expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 1, live: 0, unclaimed: 2 })

      yield* compact("Earlier turns: both workers reported back.")
      const after = yield* turn("anything new")

      // "M not yet delivered" is the half that tells the parent there is
      // something to wait for. A rebuild that lost it would leave a parent with
      // a quiet inbox and no reason to look.
      expect(system(after!).join("\n")).toContain(
        "0 worker(s) live across 1 group(s), 2 finished result(s) not yet delivered",
      )
      // It arrived in the rebuilt baseline, not as a delta against a baseline
      // the compaction just discarded.
      expect(systemTexts(after!)).toEqual([])
      expect((yield* epoch())?.baseline).toContain(
        "0 worker(s) live across 1 group(s), 2 finished result(s) not yet delivered",
      )
    }),
  )
})
