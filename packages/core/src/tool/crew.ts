export * as CrewTool from "./crew"

import { ToolFailure } from "@opencode-ai/llm"
import { eq, max } from "drizzle-orm"
import { Clock, Effect, Layer, Schema, Stream } from "effect"
import { Fanout } from "@opencode-ai/schema/fanout"
import { FanoutEvent } from "@opencode-ai/schema/fanout-event"
import { makeLocationNode } from "../effect/app-node"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { FanoutDigest } from "../fanout/digest"
import { FanoutLedger } from "../fanout/ledger"
import { FanoutLimits } from "../fanout/limits"
import { PermissionV2 } from "../permission"
import { SessionMessageTable, SessionTable } from "../session/sql"
import { SessionSchema } from "../session/schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

/**
 * The parent's on-demand view of a crew it delegated to and did not wait for.
 *
 * Delegation is non-blocking, so the per-turn cursor is all a parent gets for
 * free: three integers. This is the tool behind that cursor. In one call it
 * answers what the crew is doing, which worker has been going longest, which
 * finished result has not reached the parent yet, and where each worker's full
 * transcript lives.
 *
 * EVERY FACT REPORTED HERE COMES FROM THE DURABLE LEDGER. Never from
 * `BackgroundJob`: that registry is process-local and non-durable by its own
 * documented design, so probing it reports a healthy crew as dead after a
 * restart, and it cannot tell "my process still holds this job" from "this
 * worker is running in the other process" either. The ledger is the only record
 * that survives compaction, restart and a change of model, and it is the record
 * a parent has to be right about.
 *
 * Where the ledger is silent this tool says so in words rather than guessing.
 * The ledger is silent about liveness in particular: a `live` row records that a
 * worker was started, not that one is running. See `staleAfter` and `State`.
 */

export const name = "crew"

/**
 * How long a `live` worker's own durable record may stay frozen before the tool
 * stops calling it running.
 *
 * Ten minutes is a judgement about how long a real worker can think, read or
 * build without writing a single durable row, and it is deliberately generous:
 * firing early costs a scary word, firing late costs a parent an answer that is
 * itself out of date. It is a reporting threshold and nothing else -- no worker
 * is cancelled, retried or settled when it is crossed.
 */
export const staleAfter = 10 * 60_000

/**
 * The most worker rows one report will ever contain: the same breadth the
 * ledger enforces at spawn time. A session that has delegated all afternoon
 * still has every old row, and a report that grew with that history would be
 * the expensive call in the turn most likely to make it. The summary line
 * always carries the true totals and `omitted` carries the number of rows left
 * out, so the bound is never silent.
 */
export const maxRows = FanoutLimits.caps.maxGroups * FanoutLimits.caps.maxWorkersPerGroup

/** How often `wait` re-reads the ledger while nothing has settled. */
const pollMs = 1_000

export const MAX_WAIT_SECONDS = 1_800
export const DEFAULT_WAIT_SECONDS = 300

/**
 * The three states a worker is reported in.
 *
 * `settled` is the ledger's own terminal `status` and is a fact.
 *
 * `running` and `stale` are both derived from one piece of durable evidence:
 * whether the worker session has written anything recently. They are the most
 * a non-durable ledger can honestly say, and the gap between them is exactly
 * what the operator needs -- a row that has said `live` for three hours is a
 * row some process forgot to settle, and a parent that reads it as healthy will
 * wait on a worker that is never going to answer.
 */
export const State = Schema.Literals(["running", "stale", "settled"])
export type State = typeof State.Type

export const description = [
  "Ask what the background crew you delegated to is doing. Delegation does not block: every worker pushes its own result to you at your next turn, so use this only when you need to know now — a status you are about to act on, a worker you suspect is stuck, or a result you want in full.",
  'intent="status" (the default) lists the crew: description, agent, running/stale/settled, how long it has been going, whether a finished result is still waiting to reach you, and the child session id holding the full transcript.',
  'intent="wait" blocks until one worker finishes, or `timeout` seconds pass. This is the one place blocking is correct. Never sleep or poll in its place.',
  'intent="result" returns one worker\'s digest by id, for a result the automatic delivery did not cover. Reading it does not mark it delivered, so an unclaimed result is still pushed to you at your next turn.',
  "Every fact here is read from the durable ledger and the child sessions it points at, never from a live process, so it is still true after a restart or a compaction. `running` means the ledger has seen recent durable progress in that worker's session, not that a process is alive. `stale` means the ledger still says live but nothing has changed there for over 10 minutes — which is what a restart leaves behind, and which nothing settles on its own. Do not wait on a stale worker, and do not treat it as healthy.",
].join("\n")

export const Input = Schema.Struct({
  intent: Schema.Literals(["status", "wait", "result"])
    .annotate({
      description:
        'What to report: "status" lists the crew, "wait" blocks until a worker finishes, "result" returns one worker\'s digest.',
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed("status" as const))),
  worker: Schema.String.pipe(Schema.optional).annotate({
    description: 'The id of one worker, exactly as intent "status" listed it. Required for intent "result".',
  }),
  timeout: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_WAIT_SECONDS))
    .pipe(Schema.optional)
    .annotate({
      description: `Seconds to block for intent "wait" (maximum ${MAX_WAIT_SECONDS}, default ${DEFAULT_WAIT_SECONDS}).`,
    }),
})

/**
 * One worker as reported. Every field is a column, not a computation over
 * process state:
 *
 * - `id`, `status`, `session`  -> `fanout_worker.id` / `.status` / `.session_id`
 * - `description`              -> `fanout_worker.description`, bounded
 * - `elapsed`                  -> `fanout_worker.time_created` against now while
 *                                 live, and against `.time_updated` once settled, so a
 *                                 finished worker's elapsed time is how long it RAN
 * - `unclaimed`                -> `.claimed_seq` is null on a non-live row
 * - `agent`                    -> the child session's own `session.agent`. The worker
 *                                 table has no agent column, and the session is the
 *                                 durable record of which agent ran, so there is
 *                                 nothing to add and nowhere for the two to drift.
 * - `state`                    -> `.status`, plus the child session's newest durable
 *                                 write measured against `staleAfter`. See `State`.
 */
export const Worker = Schema.Struct({
  id: Fanout.WorkerID,
  description: Schema.String,
  agent: Schema.String,
  status: Schema.Literals(["live", "done", "error"]),
  state: State,
  elapsed: Schema.String,
  unclaimed: Schema.Boolean,
  session: SessionSchema.ID,
})
export type Worker = typeof Worker.Type

export const Output = Schema.Struct({
  summary: Schema.String,
  workers: Schema.Array(Worker),
  /** How many ledger rows the bound left out. Absent when nothing was left out. */
  omitted: Schema.optional(Schema.Int),
  /** The worker's result, framed as untrusted data, for intent "result". */
  digest: Schema.optional(Schema.String),
})
export type Output = typeof Output.Type

/**
 * A worker as the model reads it back: the encoded shape, where the branded ids
 * have been flattened to the plain strings the wire carries. `toModelOutput` is
 * handed this, never the decoded `Worker`, so the rendering helpers take it and
 * the two cannot disagree about what a row looks like.
 */
type Reported = (typeof Output)["Encoded"]["workers"][number]

/**
 * The newest durable write anywhere in a worker session, and the agent that
 * session runs as.
 *
 * This is the only liveness evidence the tool consults, and it is durable on
 * purpose. `session.time_updated` moves on every session write and
 * `session_message.time_created` moves on every message, so between them they
 * cover a worker that is running, one that stalled mid-turn, and one whose
 * process died without ever settling its ledger row. They also survive a
 * restart, which is precisely when a parent most needs the difference.
 */
const activity = Effect.fn("CrewTool.activity")(function* (db: Database.Interface["db"], sessionID: SessionSchema.ID) {
  const [session, spoke] = yield* Effect.all(
    [
      db
        .select({ agent: SessionTable.agent, updated: SessionTable.time_updated })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie),
      db
        .select({ at: max(SessionMessageTable.time_created) })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie),
    ],
    { concurrency: "unbounded" },
  )
  return { agent: session?.agent ?? undefined, last: Math.max(session?.updated ?? 0, spoke?.at ?? 0) }
})

const state = (row: FanoutLedger.CrewRow, last: number, now: number): State => {
  if (row.status !== "live") return "settled"
  return now - last > staleAfter ? "stale" : "running"
}

/** Compact and directly readable, because a model is the one reading it. */
const duration = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`
}

const describe = Effect.fn("CrewTool.describe")(function* (
  db: Database.Interface["db"],
  row: FanoutLedger.CrewRow,
  now: number,
) {
  const seen = yield* activity(db, row.sessionID)
  return {
    id: row.id,
    // The description is this parent session's own words, so it needs no
    // untrusted framing -- but it does need a bound, because it is
    // model-authored and this report is meant to cost a handful of tokens.
    description: FanoutDigest.bound(row.description, 80) ?? row.description,
    agent: seen.agent ?? "unknown",
    status: row.status,
    state: state(row, seen.last, now),
    elapsed: duration((row.status === "live" ? now : row.updatedAt) - row.createdAt),
    unclaimed: row.status !== "live" && row.claimedSeq === undefined,
    session: row.sessionID,
  } satisfies Worker
})

/**
 * Live and stale rows first, then finished results this parent has not been
 * handed, then history. What a parent needs in order to act sorts above what
 * it might want to reread, and a past result is always one `intent="result"`
 * call away.
 */
const rank = (row: Reported) => (row.status === "live" ? (row.state === "stale" ? 1 : 0) : row.unclaimed ? 2 : 3)

const report = Effect.fn("CrewTool.report")(function* (
  db: Database.Interface["db"],
  parentSessionID: SessionSchema.ID,
  now: number,
) {
  const cursor = yield* FanoutLedger.cursor(db, parentSessionID)
  const every = yield* Effect.forEach(yield* FanoutLedger.crew(db, parentSessionID), (row) => describe(db, row, now), {
    concurrency: "unbounded",
  })
  const ordered = every.toSorted((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const workers = ordered.slice(0, maxRows)
  const stale = every.filter((row) => row.state === "stale").length
  return {
    // The same sentence as the per-turn cursor, built from the same
    // `FanoutLedger.cursor` read, so the two can never disagree about how many
    // workers are live. `FanoutContext.describe` says it in one word; the
    // wording is mirrored rather than imported, so this tool stays decoupled
    // from the per-turn system-context source that owns it.
    summary:
      `${cursor.live} worker(s) live across ${cursor.groups} group(s), ${cursor.unclaimed} finished result(s) not yet delivered` +
      (stale === 0 ? "" : `, ${stale} of them stale`),
    workers,
    ...(ordered.length > workers.length ? { omitted: ordered.length - workers.length } : {}),
  }
})

const label = (row: Reported) => {
  if (row.state === "stale") return "STALE"
  if (row.status === "live") return "running"
  return row.status === "error" ? "settled (error)" : "settled"
}

const line = (row: Reported) =>
  [
    `- ${row.id} ${row.description}`,
    `agent ${row.agent}`,
    label(row),
    row.elapsed,
    row.unclaimed ? "RESULT UNCLAIMED" : undefined,
    `transcript ${row.session}`,
  ]
    .filter((part) => part !== undefined)
    .join(" | ")

const STALE_NOTE = [
  "A STALE worker is live in the ledger, but nothing has changed in its session for over 10 minutes. That is what a restart leaves behind: the row outlives the process that would have settled it, and nothing settles it on its own.",
  "Do not wait on one and do not treat it as healthy. Read its transcript session, or launch new work, which reclaims stranded crews.",
].join(" ")

const listing = (output: (typeof Output)["Encoded"]) =>
  [
    output.summary,
    "",
    ...(output.workers.length === 0 ? ["This session has not delegated any work."] : output.workers.map(line)),
    ...(output.omitted === undefined ? [] : [`… ${output.omitted} older worker(s) not listed.`]),
    ...(output.workers.some((row) => row.state === "stale") ? ["", STALE_NOTE] : []),
  ].join("\n")

/**
 * A worker's result is text a worker wrote after reading files, pages and issue
 * bodies a third party authored, so it goes through the one framing path in the
 * codebase that makes model-authored payload structurally incapable of closing
 * its own block.
 */
const framed = (row: FanoutLedger.CrewRow) =>
  FanoutDigest.frame({
    open: `<fanout-result worker="${row.id}" group="${row.groupID}" status="${row.status}">`,
    close: `</fanout-result>`,
    payload:
      row.status === "error"
        ? (row.error ?? "The worker failed without reporting a reason.")
        : (row.digest ?? "The worker finished without leaving a summary."),
    postamble: [
      `The full transcript for this worker stays in session ${row.sessionID}; read it only if you need more than this digest.`,
      "Reading it here did not mark it delivered, so an unclaimed result is still being pushed to you at your next turn.",
    ].join(" "),
  })
export type Awaited =
  | { readonly _tag: "settled"; readonly workerID: Fanout.WorkerID }
  | { readonly _tag: "timeout" }
  | { readonly _tag: "idle" }

const settled = Effect.fn("CrewTool.settled")(function* (
  db: Database.Interface["db"],
  parentSessionID: SessionSchema.ID,
) {
  const rows = yield* FanoutLedger.crew(db, parentSessionID)
  return rows.find((row) => row.status !== "live")
})

/**
 * Blocks until one of this parent's workers reaches a terminal status, or the
 * caller's deadline passes.
 *
 * Subscribing before the first read is the ordering that makes this correct
 * rather than merely likely: a settle published while that read is in flight is
 * buffered in the subscription, and both paths then converge on a ledger read,
 * so the fast path cannot miss a settle the durable path is about to see.
 *
 * The poll is not redundancy. A settle committed by another process never
 * reaches this process's pubsub, and the ledger is the only thing both of them
 * share — so the poll is what makes `wait` mean the same thing in one process
 * as it does in two.
 */
const awaitSettle = Effect.fn("CrewTool.awaitSettle")(function* (
  db: Database.Interface["db"],
  events: EventV2.Interface,
  parentSessionID: SessionSchema.ID,
  timeoutMs: number,
) {
  const announced = events.subscribe(FanoutEvent.WorkerSettled).pipe(
    Stream.filter((event) => event.data.parentSessionID === parentSessionID),
    Stream.take(1),
    Stream.runDrain,
  )
  const observed = Effect.gen(function* () {
    const found = yield* settled(db, parentSessionID)
    if (found) return { _tag: "settled", workerID: found.id } as const
    // Nothing live means nothing can settle: this parent is the only writer of
    // its crew, so waiting would spend the whole deadline to learn that.
    if ((yield* FanoutLedger.live(db, parentSessionID)).length === 0) return { _tag: "idle" } as const
    for (;;) {
      yield* Effect.sleep(pollMs)
      const next = yield* settled(db, parentSessionID)
      if (next) return { _tag: "settled", workerID: next.id } as const
    }
  })
  const raced = yield* Effect.raceFirst(announced.pipe(Effect.andThen(observed)), observed).pipe(
    Effect.timeoutOption(timeoutMs),
  )
  if (raced._tag === "None") return { _tag: "timeout" } as const satisfies Awaited
  return raced.value
})

const waited = (awaited: Awaited, limitMs: number) =>
  awaited._tag === "settled"
    ? `Waited for worker ${awaited.workerID} to finish.`
    : awaited._tag === "idle"
      ? "Nothing was live, so there was nothing to wait for."
      : `Waited ${Math.round(limitMs / 1_000)}s and no worker finished.`

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            // `digest` is already the framed block, notice and all: this path
            // must not re-wrap it or wrap it twice.
            {
              type: "text",
              text: output.digest === undefined ? listing(output) : [output.summary, "", output.digest].join("\n"),
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission
                .assert({
                  action: name,
                  resources: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${name}` })))

              const limit = (input.timeout ?? DEFAULT_WAIT_SECONDS) * 1_000
              if (input.intent === "wait") {
                const awaited = yield* awaitSettle(db, events, context.sessionID, limit)
                // Read the clock after the wait, so `elapsed` counts the wait.
                const output = yield* report(db, context.sessionID, yield* Clock.currentTimeMillis)
                return { ...output, summary: `${waited(awaited, limit)} ${output.summary}` }
              }

              const now = yield* Clock.currentTimeMillis
              if (input.intent === "result") {
                if (input.worker === undefined)
                  return yield* new ToolFailure({
                    message: 'intent "result" needs a worker id. Call intent "status" to list the crew.',
                  })
                // Scoped to this parent on purpose: a worker id is a guessable
                // string, and one session's finished work is not another's to read.
                const row = (yield* FanoutLedger.crew(db, context.sessionID)).find(
                  (worker) => worker.id === input.worker,
                )
                if (!row)
                  return yield* new ToolFailure({
                    message: `No worker ${input.worker} belongs to this session's crew. Call intent "status" to list it.`,
                  })
                return {
                  // Elapsed is on the row below; the summary says only what the
                  // row does not.
                  summary: `Result of ${row.id} (${row.status}).`,
                  workers: [yield* describe(db, row, now)],
                  digest: framed(row),
                }
              }

              return yield* report(db, context.sessionID, now)
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/crew",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Database.node, EventV2.node],
})
