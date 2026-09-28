import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import fanoutLedgerMigration from "@opencode-ai/core/database/migration/20260928020838_fanout_ledger"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const columnNames = (db: Database.Interface["db"], table: string) =>
  db
    .all<{ name: string }>(sql`PRAGMA table_info(${sql.identifier(table)})`)
    .pipe(Effect.map((rows) => rows.map((row) => row.name)))

const indexNames = (db: Database.Interface["db"], table: string) =>
  db
    .all<{ name: string }>(sql`PRAGMA index_list(${sql.identifier(table)})`)
    .pipe(Effect.map((rows) => rows.map((row) => row.name)))

const seedSession = (db: Database.Interface["db"], id: string) =>
  db.run(
    sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${id}, 'global', ${id}, '/project', 'title', 'test', 1, 1)`,
  )

describe("fanout ledger migration", () => {
  test("creates both ledger tables with the columns the ledger reads", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE project (
            id text PRIMARY KEY,
            worktree text NOT NULL,
            sandboxes text NOT NULL,
            time_created integer NOT NULL,
            time_updated integer NOT NULL
          )
        `)
        yield* db.run(sql`
          CREATE TABLE session (
            id text PRIMARY KEY,
            project_id text NOT NULL,
            slug text NOT NULL,
            directory text NOT NULL,
            title text NOT NULL,
            version text NOT NULL,
            time_created integer NOT NULL,
            time_updated integer NOT NULL
          )
        `)
        yield* DatabaseMigration.applyOnly(db, [fanoutLedgerMigration])

        expect(yield* columnNames(db, "fanout_group")).toEqual([
          "id",
          "parent_session_id",
          "title",
          "status",
          "time_created",
          "time_updated",
        ])
        expect(yield* columnNames(db, "fanout_worker")).toEqual([
          "id",
          "group_id",
          "parent_session_id",
          "session_id",
          "description",
          "status",
          "digest",
          "error",
          "settled_seq",
          "claimed_seq",
          "time_created",
          "time_updated",
        ])
        expect(yield* indexNames(db, "fanout_group")).toContain("fanout_group_parent_status_idx")
        expect(yield* indexNames(db, "fanout_worker")).toEqual(
          expect.arrayContaining([
            "fanout_worker_group_idx",
            "fanout_worker_parent_status_idx",
            "fanout_worker_parent_claimed_idx",
          ]),
        )
      }),
    )
  })

  test("deleting a parent session takes its whole crew with it", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/project', 1, 1, '[]')`,
        )
        yield* seedSession(db, "parent")
        yield* seedSession(db, "worker")
        yield* db.run(
          sql`INSERT INTO fanout_group (id, parent_session_id, title, status, time_created, time_updated) VALUES ('fng_1', 'parent', 'crew', 'live', 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO fanout_worker (id, group_id, parent_session_id, session_id, description, status, time_created, time_updated) VALUES ('fnw_1', 'fng_1', 'parent', 'worker', 'job', 'live', 1, 1)`,
        )

        yield* db.run(sql`DELETE FROM session WHERE id = 'parent'`)

        expect(yield* db.all(sql`SELECT id FROM fanout_group`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM fanout_worker`)).toEqual([])
      }),
    )
  })
})
