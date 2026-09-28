export * as FanoutLedger from "./ledger"

import { and, count, eq, isNull, ne } from "drizzle-orm"
import { Effect } from "effect"
import { Fanout } from "@opencode-ai/schema/fanout"
import type { Database } from "../database/database"
import { SessionSchema } from "../session/schema"
import { FanoutGroupTable, FanoutWorkerTable } from "./sql"
import { caps, GroupLimitExceeded, WorkerLimitExceeded } from "./limits"

/**
 * The durable fan-out ledger.
 *
 * Everything a parent needs to remember about its crew is a row here, not a
 * token in the parent's context. The parent is free to compact, restart, or
 * switch models: the ledger keeps the crew, and `cursor` re-renders a
 * three-integer summary on the next turn.
 *
 * Functions here are deliberately thin and side-effect explicit so the durable
 * event's `commit` hook can reuse `settle` inside the same transaction.
 */

type DatabaseService = Database.Interface["db"]

export interface Group {
  readonly id: Fanout.GroupID
  readonly parentSessionID: SessionSchema.ID
  readonly title: string
  readonly status: Fanout.GroupStatus
}

export interface Worker {
  readonly id: Fanout.WorkerID
  readonly groupID: Fanout.GroupID
  readonly parentSessionID: SessionSchema.ID
  readonly sessionID: SessionSchema.ID
  readonly description: string
  readonly status: Fanout.WorkerStatus
  readonly digest?: string
  readonly error?: string
  readonly settledSeq?: number
  readonly claimedSeq?: number
}

const group = (row: typeof FanoutGroupTable.$inferSelect): Group => ({
  id: row.id,
  parentSessionID: row.parent_session_id,
  title: row.title,
  status: row.status,
})

const worker = (row: typeof FanoutWorkerTable.$inferSelect): Worker => ({
  id: row.id,
  groupID: row.group_id,
  parentSessionID: row.parent_session_id,
  sessionID: row.session_id,
  description: row.description,
  status: row.status,
  ...(row.digest === null ? {} : { digest: row.digest }),
  ...(row.error === null ? {} : { error: row.error }),
  ...(row.settled_seq === null ? {} : { settledSeq: row.settled_seq }),
  ...(row.claimed_seq === null ? {} : { claimedSeq: row.claimed_seq }),
})

/** Inserts a group only while the parent is under the live-group cap. */
export const createGroup = Effect.fn("FanoutLedger.createGroup")(function* (
  db: DatabaseService,
  input: { readonly id?: Fanout.GroupID; readonly parentSessionID: SessionSchema.ID; readonly title: string },
) {
  return yield* db.transaction(
    () =>
      Effect.gen(function* () {
        const live = yield* liveGroups(db, input.parentSessionID)
        if (live >= caps.maxGroups) {
          return yield* new GroupLimitExceeded({ limit: caps.maxGroups, live })
        }
        return yield* db
          .insert(FanoutGroupTable)
          .values({
            id: input.id ?? Fanout.GroupID.create(),
            parent_session_id: input.parentSessionID,
            title: input.title,
            status: "live",
          })
          .returning()
          .get()
          .pipe(Effect.map(group), Effect.orDie)
      }),
    { behavior: "immediate" },
  )
})

/** Appends a worker to a group only while the group is under the worker cap. */
export const addWorker = Effect.fn("FanoutLedger.addWorker")(function* (
  db: DatabaseService,
  input: {
    readonly id?: Fanout.WorkerID
    readonly groupID: Fanout.GroupID
    readonly parentSessionID: SessionSchema.ID
    readonly sessionID: SessionSchema.ID
    readonly description: string
  },
) {
  return yield* db.transaction(
    () =>
      Effect.gen(function* () {
        const existing = yield* groupWorkers(db, input.groupID)
        if (existing.length >= caps.maxWorkersPerGroup) {
          return yield* new WorkerLimitExceeded({ limit: caps.maxWorkersPerGroup, live: existing.length })
        }
        return yield* db
          .insert(FanoutWorkerTable)
          .values({
            id: input.id ?? Fanout.WorkerID.create(),
            group_id: input.groupID,
            parent_session_id: input.parentSessionID,
            session_id: input.sessionID,
            description: input.description,
            status: "live",
          })
          .returning()
          .get()
          .pipe(Effect.map(worker), Effect.orDie)
      }),
    { behavior: "immediate" },
  )
})

/**
 * Records a worker's terminal state. Safe to run inside a durable event's
 * `commit` hook, which is where the fan-out completion path calls it so the row
 * and the event that announces it can never disagree.
 */
export const settle = Effect.fn("FanoutLedger.settle")(function* (
  db: DatabaseService,
  input: {
    readonly workerID: Fanout.WorkerID
    readonly status: Exclude<Fanout.WorkerStatus, "live">
    readonly digest?: string
    readonly error?: string
    readonly seq: number
  },
) {
  const updated = yield* db
    .update(FanoutWorkerTable)
    .set({
      status: input.status,
      settled_seq: input.seq,
      ...(input.digest === undefined ? {} : { digest: input.digest }),
      ...(input.error === undefined ? {} : { error: input.error }),
    })
    .where(and(eq(FanoutWorkerTable.id, input.workerID), eq(FanoutWorkerTable.status, "live")))
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (updated === undefined) return
  const remaining = yield* db
    .select({ value: count() })
    .from(FanoutWorkerTable)
    .where(and(eq(FanoutWorkerTable.group_id, updated.group_id), eq(FanoutWorkerTable.status, "live")))
    .get()
    .pipe(Effect.orDie)
  if ((remaining?.value ?? 0) > 0) return
  yield* db
    .update(FanoutGroupTable)
    .set({ status: "settled" })
    .where(and(eq(FanoutGroupTable.id, updated.group_id), eq(FanoutGroupTable.status, "live")))
    .run()
    .pipe(Effect.orDie)
})

export const findGroup = Effect.fn("FanoutLedger.findGroup")(function* (db: DatabaseService, id: Fanout.GroupID) {
  const row = yield* db.select().from(FanoutGroupTable).where(eq(FanoutGroupTable.id, id)).get().pipe(Effect.orDie)
  return row === undefined ? undefined : group(row)
})

export const findWorker = Effect.fn("FanoutLedger.findWorker")(function* (db: DatabaseService, id: Fanout.WorkerID) {
  const row = yield* db.select().from(FanoutWorkerTable).where(eq(FanoutWorkerTable.id, id)).get().pipe(Effect.orDie)
  return row === undefined ? undefined : worker(row)
})

export const findWorkerForSession = Effect.fn("FanoutLedger.findWorkerForSession")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select()
    .from(FanoutWorkerTable)
    .where(eq(FanoutWorkerTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? undefined : worker(row)
})

export const groups = Effect.fn("FanoutLedger.groups")(function* (
  db: DatabaseService,
  parentSessionID: SessionSchema.ID,
) {
  const rows = yield* db
    .select()
    .from(FanoutGroupTable)
    .where(eq(FanoutGroupTable.parent_session_id, parentSessionID))
    .all()
    .pipe(Effect.orDie)
  return rows.map(group)
})

export const groupWorkers = Effect.fn("FanoutLedger.groupWorkers")(function* (
  db: DatabaseService,
  groupID: Fanout.GroupID,
) {
  const rows = yield* db
    .select()
    .from(FanoutWorkerTable)
    .where(eq(FanoutWorkerTable.group_id, groupID))
    .all()
    .pipe(Effect.orDie)
  return rows.map(worker)
})

/** Workers a session's ledger still calls live, whether or not anything runs them. */
export const live = Effect.fn("FanoutLedger.live")(function* (db: DatabaseService, parentSessionID: SessionSchema.ID) {
  const rows = yield* db
    .select()
    .from(FanoutWorkerTable)
    .where(and(eq(FanoutWorkerTable.parent_session_id, parentSessionID), eq(FanoutWorkerTable.status, "live")))
    .all()
    .pipe(Effect.orDie)
  return rows.map(worker)
})

/** Workers that finished but whose digest has not reached the parent yet. */
export const unclaimed = Effect.fn("FanoutLedger.unclaimed")(function* (
  db: DatabaseService,
  parentSessionID: SessionSchema.ID,
) {
  const rows = yield* db
    .select()
    .from(FanoutWorkerTable)
    .where(
      and(
        eq(FanoutWorkerTable.parent_session_id, parentSessionID),
        isNull(FanoutWorkerTable.claimed_seq),
        ne(FanoutWorkerTable.status, "live"),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  return rows.map(worker)
})

/**
 * Marks a result as delivered to the parent. Called only after the digest has
 * been durably admitted into the parent's input inbox, so a crash between the
 * admit and the claim re-admits the same message id rather than dropping it.
 */
export const claim = Effect.fn("FanoutLedger.claim")(function* (
  db: DatabaseService,
  input: { readonly parentSessionID: SessionSchema.ID; readonly seq: number },
) {
  const updated = yield* db
    .update(FanoutWorkerTable)
    .set({ claimed_seq: input.seq })
    .where(
      and(
        eq(FanoutWorkerTable.parent_session_id, input.parentSessionID),
        isNull(FanoutWorkerTable.claimed_seq),
        ne(FanoutWorkerTable.status, "live"),
      ),
    )
    .returning({ id: FanoutWorkerTable.id })
    .all()
    .pipe(Effect.orDie)
  return updated.map((row) => row.id)
})

/** Every session that still owes its parent a finished-but-undelivered result. */
export const parentsWithUnclaimed = Effect.fn("FanoutLedger.parentsWithUnclaimed")(function* (db: DatabaseService) {
  const rows = yield* db
    .selectDistinct({ parentSessionID: FanoutWorkerTable.parent_session_id })
    .from(FanoutWorkerTable)
    .where(and(isNull(FanoutWorkerTable.claimed_seq), ne(FanoutWorkerTable.status, "live")))
    .all()
    .pipe(Effect.orDie)
  return rows.map((row) => row.parentSessionID)
})

/** The whole per-turn view of a crew: three integers, recomputed every turn. */
export const cursor = Effect.fn("FanoutLedger.cursor")(function* (
  db: DatabaseService,
  parentSessionID: SessionSchema.ID,
) {
  const [groupCount, liveCount, unclaimedCount] = yield* Effect.all(
    [
      db
        .select({ value: count() })
        .from(FanoutGroupTable)
        .where(eq(FanoutGroupTable.parent_session_id, parentSessionID))
        .get()
        .pipe(Effect.orDie),
      db
        .select({ value: count() })
        .from(FanoutWorkerTable)
        .where(and(eq(FanoutWorkerTable.parent_session_id, parentSessionID), eq(FanoutWorkerTable.status, "live")))
        .get()
        .pipe(Effect.orDie),
      db
        .select({ value: count() })
        .from(FanoutWorkerTable)
        .where(
          and(
            eq(FanoutWorkerTable.parent_session_id, parentSessionID),
            isNull(FanoutWorkerTable.claimed_seq),
            ne(FanoutWorkerTable.status, "live"),
          ),
        )
        .get()
        .pipe(Effect.orDie),
    ],
    { concurrency: "unbounded" },
  )
  return Fanout.Cursor.make({
    groups: groupCount?.value ?? 0,
    live: liveCount?.value ?? 0,
    unclaimed: unclaimedCount?.value ?? 0,
  })
})

export const liveGroups = Effect.fn("FanoutLedger.liveGroups")(function* (
  db: DatabaseService,
  parentSessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ value: count() })
    .from(FanoutGroupTable)
    .where(and(eq(FanoutGroupTable.parent_session_id, parentSessionID), eq(FanoutGroupTable.status, "live")))
    .get()
    .pipe(Effect.orDie)
  return row?.value ?? 0
})
