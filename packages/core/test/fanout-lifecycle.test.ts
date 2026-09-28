import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema, Stream } from "effect"
import { asc, eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Fanout } from "@opencode-ai/schema/fanout"
import { FanoutEvent } from "@opencode-ai/schema/fanout-event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { FanoutDigest } from "@opencode-ai/core/fanout/digest"
import { FanoutLedger } from "@opencode-ai/core/fanout/ledger"
import { FanoutLifecycle } from "@opencode-ai/core/fanout/lifecycle"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

const parent = SessionV2.ID.make("ses_fanout_parent")
const child = SessionV2.ID.make("ses_fanout_child")
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  for (const id of [parent, child])
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
})

const writeAssistantText = (sessionID: SessionV2.ID, seq: number, text: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const encoded = encodeMessage(
      SessionMessage.Assistant.make({
        id: SessionMessage.ID.create(),
        type: "assistant",
        agent: "build",
        model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
        content: [{ type: "text", id: "text", text }],
        time: { created: DateTime.makeUnsafe(0) },
      }),
    )
    const { type, ...data } = encoded
    const row: typeof SessionMessageTable.$inferInsert = {
      id: SessionMessage.ID.create(),
      session_id: sessionID,
      type,
      seq,
      time_created: 0,
      data,
    }
    yield* db.insert(SessionMessageTable).values(row).onConflictDoNothing().run().pipe(Effect.orDie)
  })

const inbox = Effect.fn(function* (sessionID: SessionV2.ID) {
  const { db } = yield* Database.Service
  return yield* db
    .select({ id: SessionInputTable.id, delivery: SessionInputTable.delivery })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, sessionID))
    .all()
    .pipe(Effect.orDie)
})

describe("FanoutLifecycle", () => {
  it.effect("announces a group and its workers as durable events on the group aggregate", () =>
    Effect.gen(function* () {
      yield* seed
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service

      const group = yield* FanoutLifecycle.open(db, events, { parentSessionID: parent, title: "audit" })
      const worker = yield* FanoutLifecycle.join(db, events, {
        groupID: group.id,
        parentSessionID: parent,
        sessionID: child,
        description: "read the parser",
      })

      const stored = yield* db
        .select({ type: EventTable.type, seq: EventTable.seq })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, group.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(stored.map((event) => event.type)).toEqual(["fanout.group.opened.1", "fanout.worker.joined.1"])
      // The group aggregate is decodable through the durable manifest, so a
      // restart can rebuild a parent's crew from the event log alone.
      const replayed = yield* events.durable({ aggregateID: group.id }).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.map((collected) => Array.from(collected)),
      )
      expect(replayed.map((event) => event.type)).toEqual(["fanout.group.opened", "fanout.worker.joined"])
      const joined = yield* FanoutLedger.findWorker(db, worker.id)
      expect(joined?.status).toBe("live")
      expect("settledSeq" in (joined ?? {})).toBe(false)
    }),
  )

  it.effect("commits a worker's digest in the same transaction that announces it", () =>
    Effect.gen(function* () {
      yield* seed
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const group = yield* FanoutLifecycle.open(db, events, { parentSessionID: parent, title: "audit" })
      const worker = yield* FanoutLifecycle.join(db, events, {
        groupID: group.id,
        parentSessionID: parent,
        sessionID: child,
        description: "read the parser",
      })

      const published = yield* FanoutLifecycle.settle(db, events, {
        workerID: worker.id,
        status: "done",
        digest: "the parser accepts three inputs",
      })

      // `settled_seq` can only be the event's own sequence if the row was written
      // from inside that event's transaction; a separate write could not know it.
      expect(yield* FanoutLedger.findWorker(db, worker.id)).toEqual({
        id: worker.id,
        groupID: group.id,
        parentSessionID: parent,
        sessionID: child,
        description: "read the parser",
        status: "done",
        digest: "the parser accepts three inputs",
        settledSeq: published?.durable?.seq,
      })
      expect(yield* FanoutLedger.cursor(db, parent)).toEqual({ groups: 1, live: 0, unclaimed: 1 })
      expect(yield* FanoutLedger.findGroup(db, group.id)).toMatchObject({ status: "settled" })
    }),
  )

  it.effect("ignores a second settle of the same worker instead of double-recording it", () =>
    Effect.gen(function* () {
      yield* seed
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const group = yield* FanoutLifecycle.open(db, events, { parentSessionID: parent, title: "audit" })
      const worker = yield* FanoutLifecycle.join(db, events, {
        groupID: group.id,
        parentSessionID: parent,
        sessionID: child,
        description: "read the parser",
      })

      yield* FanoutLifecycle.settle(db, events, { workerID: worker.id, status: "done", digest: "first" })
      const repeated = yield* FanoutLifecycle.settle(db, events, {
        workerID: worker.id,
        status: "error",
        error: "late",
      })

      expect(repeated).toBeUndefined()
      expect(yield* FanoutLedger.findWorker(db, worker.id)).toMatchObject({ status: "done", digest: "first" })
      const settledEvents = yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(eq(EventTable.type, "fanout.worker.settled.1"))
        .all()
        .pipe(Effect.orDie)
      expect(settledEvents).toHaveLength(1)
    }),
  )

  it.live("hands a finished worker to the parent as a steer and claims it exactly once", () =>
    Effect.gen(function* () {
      yield* seed
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const group = yield* FanoutLifecycle.open(db, events, { parentSessionID: parent, title: "audit" })
      const worker = yield* FanoutLifecycle.join(db, events, {
        groupID: group.id,
        parentSessionID: parent,
        sessionID: child,
        description: "read the parser",
      })
      yield* FanoutLifecycle.settle(db, events, { workerID: worker.id, status: "done", digest: "three inputs" })

      const delivered = yield* FanoutLifecycle.deliverUnclaimed(db, events, parent)
      expect(delivered).toEqual([worker.id])

      const rows = yield* inbox(parent)
      expect(rows).toHaveLength(1)
      expect(rows[0].delivery).toBe("steer")
      // A stable id derived from the worker means a retried delivery re-admits
      // the same message instead of duplicating the result in the parent.
      expect(String(rows[0].id)).toBe(`msg_${worker.id.slice(4)}`)

      const text = yield* db
        .select({ prompt: SessionInputTable.prompt })
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, parent))
        .get()
        .pipe(Effect.orDie)
      expect(JSON.stringify(text?.prompt)).toContain("three inputs")
      expect(JSON.stringify(text?.prompt)).toContain(child)

      expect(yield* FanoutLifecycle.deliverUnclaimed(db, events, parent)).toEqual([])
      expect(yield* inbox(parent)).toHaveLength(1)
      expect(yield* FanoutLedger.cursor(db, parent)).toEqual({ groups: 1, live: 0, unclaimed: 0 })
    }),
  )

  it.effect("digests a worker from its own final answer, bounded, never from the transcript", () =>
    Effect.gen(function* () {
      yield* seed
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const group = yield* FanoutLifecycle.open(db, events, { parentSessionID: parent, title: "audit" })
      const worker = yield* FanoutLifecycle.join(db, events, {
        groupID: group.id,
        parentSessionID: parent,
        sessionID: child,
        description: "read the parser",
      })

      // A long noisy transcript that must not reach the parent, followed by the
      // one answer that should.
      yield* writeAssistantText(child, 1, "thinking ".repeat(2_000))
      yield* writeAssistantText(child, 2, "The parser accepts three inputs and rejects a fourth.")

      const digest = yield* FanoutDigest.ofSession(db, child)
      expect(digest).toBe("The parser accepts three inputs and rejects a fourth.")
      expect(digest?.length ?? 0).toBeLessThanOrEqual(FanoutDigest.maxLength)

      yield* FanoutLifecycle.settle(db, events, { workerID: worker.id, status: "done", digest })
      expect(yield* FanoutLedger.findWorker(db, worker.id)).toMatchObject({
        digest: "The parser accepts three inputs and rejects a fourth.",
      })
    }),
  )

  it.effect("bounds an over-long answer to one truncated paragraph", () =>
    Effect.sync(() => {
      const bounded = FanoutDigest.bound("word ".repeat(400), 60)
      expect(bounded?.length).toBeLessThanOrEqual(61)
      expect(bounded?.endsWith("…")).toBe(true)
      expect(bounded?.startsWith("word word")).toBe(true)
      expect(FanoutDigest.bound("   \n  ")).toBeUndefined()
      expect(FanoutDigest.failure(new Error("provider refused").message)).toBe("provider refused")
    }),
  )
})
