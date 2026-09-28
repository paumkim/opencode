import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { FanoutLedger } from "@opencode-ai/core/fanout/ledger"
import { caps, GroupLimitExceeded, WorkerLimitExceeded } from "@opencode-ai/core/fanout/limits"
import { SessionSchema } from "@opencode-ai/core/session/schema"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const parent = SessionSchema.ID.make("ses_parent")
const child = (index: number) => SessionSchema.ID.make(`ses_child_${index}`)

const withLedger = <A, E>(body: (db: Database.Interface["db"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run(sql`PRAGMA foreign_keys = ON`)
      yield* DatabaseMigration.apply(db)
      yield* db.run(
        sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/project', 1, 1, '[]')`,
      )
      yield* db.run(
        sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${parent}, 'global', 'parent', '/project', 'title', 'test', 1, 1)`,
      )
      for (let index = 0; index < 16; index++)
        yield* db.run(
          sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${child(index)}, 'global', ${`child_${index}`}, '/project', 'title', 'test', 1, 1)`,
        )
      return yield* body(db)
    }).pipe(
      Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename: ":memory:", disableWAL: true }))),
      Effect.scoped,
    ),
  )

const spawnGroup = (db: Database.Interface["db"], title: string) =>
  FanoutLedger.createGroup(db, { parentSessionID: parent, title })

const addWorker = (db: Database.Interface["db"], groupID: string, index: number) =>
  FanoutLedger.addWorker(db, {
    groupID: groupID as never,
    parentSessionID: parent,
    sessionID: child(index),
    description: `job ${index}`,
  })

describe("FanoutLedger", () => {
  test("starts a session with an empty cursor and records its first group", async () => {
    await withLedger((db) =>
      Effect.gen(function* () {
        expect(yield* FanoutLedger.cursor(db, parent)).toEqual({ groups: 0, live: 0, unclaimed: 0 })

        const created = yield* spawnGroup(db, "crew")
        const first = yield* addWorker(db, created.id, 0)

        expect(yield* FanoutLedger.cursor(db, parent)).toEqual({ groups: 1, live: 1, unclaimed: 0 })
        expect(yield* FanoutLedger.findWorkerForSession(db, child(0))).toEqual({
          id: first.id,
          groupID: created.id,
          parentSessionID: parent,
          sessionID: child(0),
          description: "job 0",
          status: "live",
        })
        expect((yield* FanoutLedger.groups(db, parent)).map((entry) => entry.status)).toEqual(["live"])
      }),
    )
  })

  test("refuses a fourth concurrent group and frees the slot once a group settles", async () => {
    await withLedger((db) =>
      Effect.gen(function* () {
        const created = yield* Effect.all(
          Array.from({ length: caps.maxGroups }, (_, index) => spawnGroup(db, `crew ${index}`)),
          { concurrency: "unbounded" },
        )
        const error = yield* spawnGroup(db, "overflow").pipe(Effect.flip)
        expect(error).toBeInstanceOf(GroupLimitExceeded)
        expect(error.message).toContain("3 of 3")

        const worker = yield* addWorker(db, created[0].id, 0)
        yield* FanoutLedger.settle(db, { workerID: worker.id, status: "done", digest: "ok", seq: 1 })

        expect(yield* FanoutLedger.cursor(db, parent)).toEqual({ groups: 3, live: 0, unclaimed: 1 })
        expect((yield* FanoutLedger.findGroup(db, created[0].id))?.status).toBe("settled")
        // The freed slot is the only thing that changed; the other two stay live.
        expect((yield* spawnGroup(db, "next")).status).toBe("live")
      }),
    )
  })

  test("refuses a fifth worker in one group", async () => {
    await withLedger((db) =>
      Effect.gen(function* () {
        const created = yield* spawnGroup(db, "crew")
        for (let index = 0; index < caps.maxWorkersPerGroup; index++) yield* addWorker(db, created.id, index)

        const error = yield* addWorker(db, created.id, 8).pipe(Effect.flip)
        expect(error).toBeInstanceOf(WorkerLimitExceeded)
        expect(error.message).toContain("4 of 4")
        expect(yield* FanoutLedger.groupWorkers(db, created.id)).toHaveLength(caps.maxWorkersPerGroup)
      }),
    )
  })

  test("keeps a settled result unclaimed until the parent has been handed it", async () => {
    await withLedger((db) =>
      Effect.gen(function* () {
        const created = yield* spawnGroup(db, "crew")
        const done = yield* addWorker(db, created.id, 0)
        const stillRunning = yield* addWorker(db, created.id, 1)

        yield* FanoutLedger.settle(db, { workerID: done.id, status: "done", digest: "the answer", seq: 7 })

        expect(yield* FanoutLedger.unclaimed(db, parent)).toMatchObject([{ id: done.id, digest: "the answer" }])
        expect(yield* FanoutLedger.cursor(db, parent)).toEqual({ groups: 1, live: 1, unclaimed: 1 })
        expect((yield* FanoutLedger.findGroup(db, created.id))?.status).toBe("live")

        expect(yield* FanoutLedger.claim(db, { parentSessionID: parent, seq: 9 })).toEqual([done.id])
        expect(yield* FanoutLedger.unclaimed(db, parent)).toEqual([])
        expect(yield* FanoutLedger.cursor(db, parent)).toEqual({ groups: 1, live: 1, unclaimed: 0 })
        // A live worker is never claimable: claiming must not retire running work.
        expect(yield* FanoutLedger.claim(db, { parentSessionID: parent, seq: 10 })).toEqual([])
        expect((yield* FanoutLedger.findWorker(db, stillRunning.id))?.status).toBe("live")
      }),
    )
  })

  test("settles a group only after its last worker settles and ignores a repeated settle", async () => {
    await withLedger((db) =>
      Effect.gen(function* () {
        const created = yield* spawnGroup(db, "crew")
        const first = yield* addWorker(db, created.id, 0)
        const second = yield* addWorker(db, created.id, 1)

        yield* FanoutLedger.settle(db, { workerID: first.id, status: "error", error: "boom", seq: 1 })
        expect((yield* FanoutLedger.findGroup(db, created.id))?.status).toBe("live")
        expect(yield* FanoutLedger.findWorker(db, first.id)).toMatchObject({
          status: "error",
          error: "boom",
          settledSeq: 1,
        })

        yield* FanoutLedger.settle(db, { workerID: second.id, status: "done", digest: "second", seq: 2 })
        yield* FanoutLedger.settle(db, { workerID: second.id, status: "error", error: "late", seq: 3 })

        expect((yield* FanoutLedger.findGroup(db, created.id))?.status).toBe("settled")
        expect(yield* FanoutLedger.findWorker(db, second.id)).toMatchObject({ status: "done", digest: "second" })
      }),
    )
  })
})
