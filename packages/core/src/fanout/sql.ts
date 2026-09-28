import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { Fanout } from "@opencode-ai/schema/fanout"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"

/**
 * The durable fan-out ledger.
 *
 * A parent that fans out has to be able to lose its own context -- compaction,
 * restart, a fresh provider turn with a different model -- and still know what
 * its crew is doing. Nothing about a fan-out therefore lives in the parent's
 * prompt: these two tables are the whole record, and the parent reads them
 * through a per-turn cursor (see `fanout/context.ts`).
 */
export const FanoutGroupTable = sqliteTable(
  "fanout_group",
  {
    id: text().$type<Fanout.GroupID>().primaryKey(),
    parent_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    title: text().notNull(),
    status: text().$type<Fanout.GroupStatus>().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("fanout_group_parent_status_idx").on(table.parent_session_id, table.status),
    index("fanout_group_session_idx").on(table.parent_session_id),
  ],
)

export const FanoutWorkerTable = sqliteTable(
  "fanout_worker",
  {
    id: text().$type<Fanout.WorkerID>().primaryKey(),
    group_id: text()
      .$type<Fanout.GroupID>()
      .notNull()
      .references(() => FanoutGroupTable.id, { onDelete: "cascade" }),
    parent_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    description: text().notNull(),
    status: text().$type<Fanout.WorkerStatus>().notNull(),
    /**
     * The worker's result, reduced to a bounded digest. The full transcript stays
     * in the child session; only this crosses back into the parent's orbit.
     */
    digest: text(),
    error: text(),
    /** Durable sequence of the settle event, or undefined while the worker is live. */
    settled_seq: integer(),
    /**
     * Durable sequence recorded once this worker's digest has been pushed into the
     * parent's input inbox. Undefined means unclaimed: finished, but the parent
     * has not been handed the result yet.
     */
    claimed_seq: integer(),
    ...Timestamps,
  },
  (table) => [
    index("fanout_worker_group_idx").on(table.group_id),
    index("fanout_worker_parent_status_idx").on(table.parent_session_id, table.status),
    index("fanout_worker_parent_claimed_idx").on(table.parent_session_id, table.claimed_seq),
    index("fanout_worker_session_idx").on(table.session_id),
    index("fanout_worker_settled_idx").on(table.settled_seq),
  ],
)
