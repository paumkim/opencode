export * as SessionUsage from "./usage"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { and, asc, desc, eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { MessageID, SessionID } from "./schema"
import { NotFoundError } from "@/storage/storage"
import type { DeepMutable } from "@opencode-ai/core/schema"

/**
 * One assistant turn. Every field here is already persisted on the message
 * (`SessionV1.Assistant`); nothing in this module infers usage, it only reads it
 * back. `input` is the size of the context that turn was *sent*, which is the
 * number that grows whether or not the model said anything, and is why a
 * conversation can get expensive while the transcript looks short.
 */
export const Turn = Schema.Struct({
  messageID: MessageID,
  time: Schema.Finite,
  duration: Schema.optional(Schema.Finite),
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optional(Schema.String),
  agent: Schema.String,
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  /** `input + output + reasoning + cacheRead + cacheWrite`, when the parts are known. */
  total: Schema.Finite,
  cost: Schema.Finite,
}).annotate({ identifier: "SessionUsageTurn" })
export type Turn = DeepMutable<Schema.Schema.Type<typeof Turn>>

export const Totals = Schema.Struct({
  turns: Schema.Finite,
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  cost: Schema.Finite,
  /** Share of all input that came from the prompt cache, 0-1. */
  cacheHitRate: Schema.Finite,
  /** The most input a single turn was sent; the conversation's high-water mark. */
  peakInput: Schema.Finite,
}).annotate({ identifier: "SessionUsageTotals" })
export type Totals = DeepMutable<Schema.Schema.Type<typeof Totals>>

export const Finding = Schema.Struct({
  id: Schema.String,
  severity: Schema.Literals(["error", "warn", "info"]),
  title: Schema.String,
  detail: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
}).annotate({ identifier: "SessionUsageFinding" })
export type Finding = DeepMutable<Schema.Schema.Type<typeof Finding>>

export const Report = Schema.Struct({
  sessionID: SessionID,
  title: Schema.String,
  /** The session's own recorded totals, which are the number the user is comparing against. */
  sessionCost: Schema.Finite,
  sessionTokens: Schema.Finite,
  turns: Schema.Array(Turn),
  totals: Totals,
  findings: Schema.Array(Finding),
}).annotate({ identifier: "SessionUsageReport" })
export type Report = DeepMutable<Schema.Schema.Type<typeof Report>>

export const Input = Schema.Struct({
  sessionID: SessionID,
  /** Most recent N turns, for a long conversation whose every turn does not fit. */
  limit: Schema.optional(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
})
export type Input = Schema.Schema.Type<typeof Input>

// ---------------------------------------------------------------------------
// Analysis
//
// Everything below is a pure function over plain rows so the diagnosis can be
// tested against hand-written histories, including the ones no real run
// produces on demand.
// ---------------------------------------------------------------------------

/** Below this, a turn is too small for its cost shape to mean anything. */
const LARGE_CONTEXT = 20_000
/** A cache that is doing its job reads back most of what was sent. */
const HEALTHY_CACHE_HIT = 0.6
/**
 * One turn carrying this share of the spend is worth naming. Strictly greater,
 * because in a two-turn conversation the larger of the two is always at least
 * half and "this turn was half your bill" names nothing.
 */
const DOMINANCE = 0.5

export function totalOf(turn: Pick<Turn, "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite">): number {
  return turn.input + turn.output + turn.reasoning + turn.cacheRead + turn.cacheWrite
}

/** A row as it is stored: every column but the total, which is derived. */
export type Untotalled = Omit<Turn, "total">

export function withTotal(turn: Untotalled): Turn {
  return { ...turn, total: totalOf(turn) }
}

export function summarize(turns: readonly Turn[]): Totals {
  const sum = (pick: (turn: Turn) => number) => turns.reduce((total, turn) => total + pick(turn), 0)
  const input = sum((turn) => turn.input)
  const cacheRead = sum((turn) => turn.cacheRead)
  return {
    turns: turns.length,
    input,
    output: sum((turn) => turn.output),
    reasoning: sum((turn) => turn.reasoning),
    cacheRead,
    cacheWrite: sum((turn) => turn.cacheWrite),
    cost: sum((turn) => turn.cost),
    // Cache reads are billed and re-sent alike but cost far less, so the hit rate
    // is a share of all input tokens, not a share of the non-cached remainder.
    cacheHitRate: input + cacheRead === 0 ? 0 : cacheRead / (input + cacheRead),
    peakInput: turns.reduce((peak, turn) => Math.max(peak, turn.input), 0),
  }
}

/** Currency for a cost figure, degrading to plain numbers when every turn is free. */
export function formatCost(cost: number, totals: Pick<Totals, "cost">): string {
  if (totals.cost === 0) return cost === 0 ? "—" : cost.toFixed(4)
  if (cost >= 1) return `$${cost.toFixed(2)}`
  if (cost >= 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(6)}`
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

export function analyze(turns: readonly Turn[]): Finding[] {
  if (turns.length === 0) return []
  const findings: Finding[] = []
  const totals = summarize(turns)

  // The prompt cache is the one lever in this data that changes a bill by an
  // order of magnitude on its own, and the failure is silent: nothing errors,
  // the context is just re-billed in full every turn.
  if (totals.peakInput >= LARGE_CONTEXT && totals.cacheHitRate < HEALTHY_CACHE_HIT) {
    findings.push({
      id: "usage.cache-miss",
      severity: "warn",
      title: "The prompt cache is barely being used",
      detail:
        `This conversation sent up to ${formatTokens(totals.peakInput)} tokens of context but only ` +
        `${(totals.cacheHitRate * 100).toFixed(0)}% of its input came from the cache.`,
      hint: "A cache that is invalidated every turn re-bills the whole context each time; check for anything that changes early in the prompt between turns.",
    })
  }

  // A single turn that carries most of the spend is the answer to "where did
  // the money go", and it is invisible in a transcript that looks even.
  let spender: Turn | undefined
  for (const turn of turns) if (!spender || turn.cost > spender.cost) spender = turn
  if (spender && totals.cost > 0 && spender.cost / totals.cost > DOMINANCE && turns.length > 1) {
    findings.push({
      id: "usage.turn-dominates",
      severity: "info",
      title: `One turn is ${((spender.cost / totals.cost) * 100).toFixed(0)}% of this session's cost`,
      detail: `${spender.modelID} used ${formatTokens(spender.output)} output and ${formatTokens(spender.reasoning)} reasoning tokens on ${formatCost(spender.cost, totals)}.`,
    })
  }

  // Reasoning tokens are billed as output and are the most common surprise on a
  // reasoning model, so they are worth separating from the answer the user got.
  if (totals.reasoning > 0 && totals.output > 0 && totals.reasoning > totals.output) {
    findings.push({
      id: "usage.reasoning-heavy",
      severity: "info",
      title: "Most of the generated tokens were reasoning, not answer",
      detail: `${formatTokens(totals.reasoning)} reasoning against ${formatTokens(totals.output)} output.`,
      hint: "A lower reasoning effort on the agent, or a model with less appetite for it, cuts both.",
    })
  }

  // Context that only ever grows is what compaction exists to stop; a
  // conversation that never compacted has a per-turn cost that grows with it.
  if (turns.length >= 4) {
    const first = turns[0].input
    const last = turns[turns.length - 1].input
    if (first > 0 && last >= first * 3) {
      findings.push({
        id: "usage.context-growth",
        severity: "info",
        title: `Context grew from ${formatTokens(first)} to ${formatTokens(last)} tokens across ${turns.length} turns`,
        detail: "Every turn re-sends the whole window, so each one costs more than the last.",
        hint: "Compaction prunes the middle of a long conversation; `opencode run --continue` will use it, or ask the agent to compact.",
      })
    }
  }

  return findings
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface Interface {
  readonly report: (input: Input) => Effect.Effect<Report, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionUsage") {}

// The JSON path has to be part of the SQL text, not a bind parameter: a
// helper taking the path as a value makes drizzle emit a `?` and SQLite
// compares `data` against a path chosen at runtime, which it cannot do.
const assistant = sql<string>`json_extract(${MessageTable.data}, '$.role')`
const created = sql<number | null>`json_extract(${MessageTable.data}, '$.time.created')`
const completed = sql<number | null>`json_extract(${MessageTable.data}, '$.time.completed')`
const providerID = sql<string | null>`json_extract(${MessageTable.data}, '$.providerID')`
const modelID = sql<string | null>`json_extract(${MessageTable.data}, '$.modelID')`
const variant = sql<string | null>`json_extract(${MessageTable.data}, '$.variant')`
const agent = sql<string | null>`json_extract(${MessageTable.data}, '$.agent')`
const inputTokens = sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.input')`
const outputTokens = sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.output')`
const reasoningTokens = sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.reasoning')`
const cacheRead = sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.cache.read')`
const cacheWrite = sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.cache.write')`
const cost = sql<number | null>`json_extract(${MessageTable.data}, '$.cost')`

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const turnsOf = (sessionID: SessionID, limit: number | undefined) => {
      const base = db
        .select({
          messageID: MessageTable.id,
          time: MessageTable.time_created,
          created,
          completed,
          providerID,
          modelID,
          variant,
          agent,
          input: inputTokens,
          output: outputTokens,
          reasoning: reasoningTokens,
          cacheRead,
          cacheWrite,
          cost,
        })
        .from(MessageTable)
        .where(
          and(
            eq(MessageTable.session_id, sessionID),
            // Only an assistant turn reports usage; a user message has none, and
            // selecting on the stored role rather than the column keeps the
            // index on session_id usable.
            sql`${assistant} = 'assistant'`,
          ),
        )
      // A limit means the *newest* turns, so the window is taken from the end of
      // the conversation and then put back in order. Taking the first N of an
      // ascending query would report the oldest turns under a flag that says
      // otherwise.
      const query = limit
        ? base.orderBy(desc(MessageTable.time_created), desc(MessageTable.id)).limit(limit)
        : base.orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
      return query
        .all()
        .pipe(Effect.orDie)
        .pipe(
          Effect.map((rows) =>
            (limit ? [...rows].reverse() : rows).map((row) =>
              withTotal({
                messageID: row.messageID,
                time: row.time,
                // A turn that is still running has no completion time; leaving the
                // duration off is honest, and zero would read as "instant".
                ...(row.created !== null && row.completed !== null ? { duration: row.completed - row.created } : {}),
                providerID: row.providerID ?? "unknown",
                modelID: row.modelID ?? "unknown",
                ...(row.variant ? { variant: row.variant } : {}),
                agent: row.agent ?? "",
                input: row.input ?? 0,
                output: row.output ?? 0,
                reasoning: row.reasoning ?? 0,
                cacheRead: row.cacheRead ?? 0,
                cacheWrite: row.cacheWrite ?? 0,
                cost: row.cost ?? 0,
              }),
            ),
          ),
        )
    }

    const report: Interface["report"] = Effect.fn("SessionUsage.report")(function* (input: Input) {
      const sessionID = input.sessionID
      const session = yield* db
        .select({
          id: SessionTable.id,
          title: SessionTable.title,
          cost: SessionTable.cost,
          input: SessionTable.tokens_input,
          output: SessionTable.tokens_output,
          reasoning: SessionTable.tokens_reasoning,
          cacheRead: SessionTable.tokens_cache_read,
          cacheWrite: SessionTable.tokens_cache_write,
        })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)

      if (!session) return yield* new NotFoundError({ message: `Session not found: ${sessionID}` })

      const turns = yield* turnsOf(sessionID, input.limit)
      const totals = summarize(turns)
      return {
        sessionID: session.id,
        title: session.title,
        sessionCost: session.cost ?? 0,
        sessionTokens:
          (session.input ?? 0) +
          (session.output ?? 0) +
          (session.reasoning ?? 0) +
          (session.cacheRead ?? 0) +
          (session.cacheWrite ?? 0),
        turns,
        totals,
        findings: analyze(turns),
      }
    })

    return Service.of({ report })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })
