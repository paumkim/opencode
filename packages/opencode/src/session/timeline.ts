export * as SessionTimeline from "./timeline"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Token } from "@opencode-ai/core/util/token"
import { and, asc, eq, sql } from "drizzle-orm"
import { NotFoundError } from "@/storage/storage"
import { MessageID, PartID, SessionID } from "./schema"
import type { DeepMutable } from "@opencode-ai/core/schema"

/**
 * What a session's context window is actually made of.
 *
 * `session usage` answers "what did this cost". It cannot answer "why is every
 * turn eighty thousand tokens", because the per-turn input figure is a single
 * number with no account of what produced it. A transcript that looks like a
 * dozen short exchanges can be carrying a hundred kilobytes of tool output, and
 * the only way to see that is to size the parts themselves.
 *
 * Sizes here are token *estimates* from the same `Token.estimate` the rest of
 * the harness uses for compaction, so the numbers are comparable to each other
 * and to what compaction reasons about. They are not a provider's count, and
 * this module never pretends otherwise: it reconciles its own total against the
 * real input token count of the last turn (see `coverage`) and reports the
 * disagreement instead of hiding it.
 */

/** The kinds of thing that can occupy the window, in the order they read best. */
export const Bucket = Schema.Literals([
  "user",
  "assistant",
  "reasoning",
  "tool-input",
  "tool-output",
  "tool-error",
  "file",
  "synthetic",
  "other",
]).annotate({ identifier: "SessionTimelineBucket" })
export type Bucket = Schema.Schema.Type<typeof Bucket>

/** One contribution to the window, sized and attributed. */
export const Share = Schema.Struct({
  bucket: Bucket,
  /** Estimated tokens this bucket occupies. */
  tokens: Schema.Finite,
  /** Share of the estimated total, 0-1. */
  share: Schema.Finite,
  /** How many parts fell into this bucket. */
  parts: Schema.Finite,
}).annotate({ identifier: "SessionTimelineShare" })
export type Share = DeepMutable<Schema.Schema.Type<typeof Share>>

/**
 * A single part large enough to be worth the user's attention.
 *
 * `partID` and `messageID` are here so the finding is actionable: the point of
 * naming a part is being able to go and look at it.
 */
export const Contributor = Schema.Struct({
  partID: PartID,
  messageID: MessageID,
  role: Schema.String,
  /** The tool that produced this, for a tool part; the bucket otherwise. */
  label: Schema.String,
  bucket: Bucket,
  tokens: Schema.Finite,
  share: Schema.Finite,
  /** First line of the part, trimmed, so a row is identifiable without opening it. */
  preview: Schema.String,
}).annotate({ identifier: "SessionTimelineContributor" })
export type Contributor = DeepMutable<Schema.Schema.Type<typeof Contributor>>

/** The conversation's shape: what happened, as counts. */
export const Shape = Schema.Struct({
  user: Schema.Finite,
  assistant: Schema.Finite,
  /** Tool calls that finished. */
  tools: Schema.Finite,
  /** Tool calls that ended in an error. */
  errors: Schema.Finite,
  /** A reasoning part the model actually wrote. */
  reasoning: Schema.Finite,
  compactions: Schema.Finite,
  retries: Schema.Finite,
  /** Subagent transcripts, which are context the parent pays for. */
  subtasks: Schema.Finite,
  /** Wall-clock span covered by the session, ms. */
  duration: Schema.Finite,
  /** Tool names by call count, descending. */
  toolsByName: Schema.Array(
    Schema.Struct({ tool: Schema.String, calls: Schema.Finite, errors: Schema.Finite }).annotate({
      identifier: "SessionTimelineTool",
    }),
  ),
}).annotate({ identifier: "SessionTimelineShape" })
export type Shape = DeepMutable<Schema.Schema.Type<typeof Shape>>

/**
 * How this module's estimate compares with a number the provider supplied.
 *
 * `measured` is the last turn's real input token count — the size of the window
 * as the model saw it. `estimated` is what the parts add up to. A ratio near one
 * means the breakdown accounts for the window; a ratio far from one means the
 * parts are not the whole story (tool definitions and the system prompt are not
 * parts at all) and the *shares* should be read as shares of the parts, not of
 * the window.
 */
export const Coverage = Schema.Struct({
  measured: Schema.Finite,
  estimated: Schema.Finite,
  /** `estimated / measured`; 0 when there is no measurement to compare against. */
  ratio: Schema.Finite,
}).annotate({ identifier: "SessionTimelineCoverage" })
export type Coverage = DeepMutable<Schema.Schema.Type<typeof Coverage>>

export const Finding = Schema.Struct({
  id: Schema.String,
  severity: Schema.Literals(["error", "warn", "info"]),
  title: Schema.String,
  detail: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
}).annotate({ identifier: "SessionTimelineFinding" })
export type Finding = DeepMutable<Schema.Schema.Type<typeof Finding>>

export const Report = Schema.Struct({
  sessionID: SessionID,
  title: Schema.String,
  shape: Shape,
  /** Estimated context, largest bucket first. */
  shares: Schema.Array(Share),
  /** The parts carrying the most context, largest first. */
  contributors: Schema.Array(Contributor),
  coverage: Coverage,
  findings: Schema.Array(Finding),
}).annotate({ identifier: "SessionTimelineReport" })
export type Report = DeepMutable<Schema.Schema.Type<typeof Report>>

export const Input = Schema.Struct({
  sessionID: SessionID,
  /** How many of the largest parts to report. */
  limit: Schema.optional(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
}).annotate({ identifier: "SessionTimelineInput" })
export type Input = Schema.Schema.Type<typeof Input>

// ---------------------------------------------------------------------------
// Analysis
//
// Pure functions over plain rows, so a history no real run produces on demand
// can still be reasoned about.
// ---------------------------------------------------------------------------

/** Above this share, one part is the answer to "why is this session large". */
const DOMINANT_SHARE = 0.25
/** Above this share, one bucket is worth naming on its own. */
const BUCKET_SHARE = 0.4
/** A preview longer than this stops being a label. */
const PREVIEW = 72

export const EMPTY_SHAPE: Shape = {
  user: 0,
  assistant: 0,
  tools: 0,
  errors: 0,
  reasoning: 0,
  compactions: 0,
  retries: 0,
  subtasks: 0,
  duration: 0,
  toolsByName: [],
}

/** A part as stored, reduced to what the breakdown needs. */
export type Row = {
  id: PartID
  messageID: MessageID
  role: string
  type: string
  data: unknown
  time: number
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const asString = (value: unknown): string => (typeof value === "string" ? value : "")

/**
 * Which bucket a part belongs to, and how big it is.
 *
 * A part's size is estimated from the text the model was actually sent, not from
 * the whole stored row: a tool call's stored metadata includes bookkeeping the
 * model never sees, and counting it would overstate every tool.
 */
export function measure(row: Row): { bucket: Bucket; tokens: number; label: string; preview: string } {
  const data = asRecord(row.data)
  switch (row.type) {
    case "text":
    case "reasoning": {
      const text = asString(data.text)
      const synthetic = data.synthetic === true
      return {
        // A synthetic text part is the harness talking to itself: a reminder, a
        // compaction note. It occupies the window exactly like any other text,
        // and separating it is the difference between "the agent wrote this" and
        // "the agent was told this".
        bucket:
          row.type === "reasoning" ? "reasoning" : synthetic ? "synthetic" : row.role === "user" ? "user" : "assistant",
        tokens: Token.estimate(text),
        label: row.type === "reasoning" ? "reasoning" : synthetic ? "harness text" : row.role,
        preview: text,
      }
    }
    case "tool": {
      const state = asRecord(data.state)
      const tool = asString(data.tool)
      const status = asString(state.status)
      // A tool's arguments are replayed verbatim on every later turn, so a large
      // input is a permanent cost; a large output is only a cost until
      // compaction drops it. Counting them together would hide which of the two
      // a user can actually do something about.
      const input = state.input === undefined || state.input === null ? "" : JSON.stringify(state.input)
      if (status === "error") {
        const error = asString(state.error)
        return {
          bucket: "tool-error",
          tokens: Token.estimate(input + error),
          label: `${tool} (error)`,
          preview: error || input,
        }
      }
      // An input on its own is still a distinct fact about the window, so it is
      // reported when the output is empty rather than folded into a zero.
      const output = asString(state.output)
      if (output === "" && input !== "") {
        return { bucket: "tool-input", tokens: Token.estimate(input), label: tool, preview: input }
      }
      return {
        bucket: "tool-output",
        tokens: Token.estimate(input + output),
        label: tool,
        preview: output || asString(state.title) || input,
      }
    }
    case "file": {
      // An attached file is content the model reads, not a mention of it.
      const source = asRecord(data.source)
      const text = asString(data.text) || asString(source.text)
      return { bucket: "file", tokens: Token.estimate(text), label: asString(data.filename) || "file", preview: text }
    }
    case "compaction":
      return { bucket: "other", tokens: 0, label: "compaction", preview: "" }
    default:
      return { bucket: "other", tokens: 0, label: row.type, preview: "" }
  }
}

/** A one-line identifier for a part, for a table a user reads rather than parses. */
export function previewOf(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? ""
  const trimmed = line.trim()
  return trimmed.length > PREVIEW ? trimmed.slice(0, PREVIEW - 1) + "…" : trimmed
}

export function sharesOf(rows: readonly Row[]): Share[] {
  const totals = new Map<Bucket, { tokens: number; parts: number }>()
  let sum = 0
  for (const row of rows) {
    const { bucket, tokens } = measure(row)
    if (tokens === 0) continue
    const entry = totals.get(bucket) ?? { tokens: 0, parts: 0 }
    entry.tokens += tokens
    entry.parts += 1
    totals.set(bucket, entry)
    sum += tokens
  }
  return [...totals.entries()]
    .map(([bucket, entry]) => ({
      bucket,
      tokens: entry.tokens,
      share: sum === 0 ? 0 : entry.tokens / sum,
      parts: entry.parts,
    }))
    .sort((a, b) => b.tokens - a.tokens)
}

export function contributorsOf(rows: readonly Row[], limit: number): Contributor[] {
  return rows
    .map((row) => {
      const { bucket, tokens, label, preview } = measure(row)
      return {
        partID: row.id,
        messageID: row.messageID,
        role: row.role,
        label,
        bucket,
        tokens,
        share: 0,
        preview: previewOf(preview),
      }
    })
    .filter((item) => item.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit)
}

export function shapeOf(rows: readonly Row[], times: readonly number[]): Shape {
  const shape: Shape = { ...EMPTY_SHAPE, toolsByName: [] }
  const tools = new Map<string, { calls: number; errors: number }>()
  // Turns are counted per *message*, not per part: one assistant turn is many
  // parts, and counting parts would report a three-line reply as seven turns.
  const messages = new Set<string>()
  for (const row of rows) {
    messages.add(`${row.role}:${row.messageID}`)
    if (row.type === "reasoning") shape.reasoning += 1
    if (row.type === "compaction") shape.compactions += 1
    if (row.type === "retry") shape.retries += 1
    if (row.type === "subtask" || row.type === "agent") shape.subtasks += 1
    if (row.type === "tool") {
      const data = asRecord(row.data)
      const tool = asString(data.tool)
      const status = asString(asRecord(data.state).status)
      const entry = tools.get(tool) ?? { calls: 0, errors: 0 }
      entry.calls += 1
      if (status === "error") entry.errors += 1
      tools.set(tool, entry)
    }
  }
  for (const key of messages) {
    if (key.startsWith("user:")) shape.user += 1
    else shape.assistant += 1
  }
  shape.tools = [...tools.values()].reduce((total, entry) => total + entry.calls, 0)
  shape.errors = [...tools.values()].reduce((total, entry) => total + entry.errors, 0)
  shape.toolsByName = [...tools.entries()]
    .map(([tool, entry]) => ({ tool, calls: entry.calls, errors: entry.errors }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))
  // Sorted times, because the first and last timestamp are the span and nothing
  // guarantees the query returned them in order.
  const sorted = [...times].sort((a, b) => a - b)
  shape.duration = sorted.length === 0 ? 0 : sorted[sorted.length - 1] - sorted[0]
  return shape
}

export function analyze(input: {
  shares: readonly Share[]
  contributors: readonly Contributor[]
  shape: Shape
  coverage: Coverage
}): Finding[] {
  const findings: Finding[] = []
  const { shape, coverage } = input

  const [largest, ...rest] = input.shares

  // The single largest part is the answer to "why is this session large", and
  // it is invisible in a transcript that reads as a dozen short exchanges.
  const top = input.contributors[0]
  if (top && top.share >= DOMINANT_SHARE) {
    findings.push({
      id: "timeline.part-dominates",
      severity: top.share >= 0.5 ? "warn" : "info",
      title: `One ${top.label} part is ${(top.share * 100).toFixed(0)}% of the estimated context`,
      detail: `${formatTokens(top.tokens)} tokens estimated from ${top.partID} (${top.preview || top.label}).`,
      hint: "Compact the session, or have the agent read less of it at once; this part is re-sent on every later turn.",
    })
  }

  // One bucket carrying most of the window is a habit, not an accident: a tool
  // whose output dwarfs the conversation is worth naming even when no single
  // call is dominant.
  if (largest && largest.share >= BUCKET_SHARE && rest.length > 0) {
    findings.push({
      id: "timeline.bucket-dominates",
      severity: "info",
      title: `Most of the context is ${describeBucket(largest.bucket)}`,
      detail: `${formatTokens(largest.tokens)} tokens across ${largest.parts} part${largest.parts === 1 ? "" : "s"}, against ${rest.length} other kind${rest.length === 1 ? "" : "s"} of content.`,
    })
  }

  // A tool that keeps failing is a different problem from a tool that is large,
  // and the transcript shows it only as one more red line among many.
  for (const tool of shape.toolsByName) {
    if (tool.calls >= 3 && tool.errors / tool.calls > 0.5) {
      findings.push({
        id: `timeline.tool-fails.${tool.tool}`,
        severity: "warn",
        title: `${tool.tool} failed ${tool.errors} of ${tool.calls} times`,
        detail: "Each failed call still sent its input and its error text through the window.",
        hint: "A tool that usually fails is usually being called with the wrong shape; fixing the call cuts both the errors and the retries.",
      })
      break
    }
  }

  // The estimate is reconciled against the provider's own count. If the parts
  // account for far less than the window, then the window is mostly something
  // that is not a part — tool definitions and the system prompt — and saying so
  // is more useful than a breakdown that silently stops at 40%.
  if (coverage.measured > 0 && coverage.ratio < 0.5) {
    findings.push({
      id: "timeline.unaccounted",
      severity: "info",
      title: `Parts account for only ${(coverage.ratio * 100).toFixed(0)}% of the last turn's context`,
      detail: `${formatTokens(coverage.estimated)} estimated against the ${formatTokens(coverage.measured)} the provider was sent on the last turn.`,
      hint: "The rest is the system prompt and the tool definitions, which are sent every turn regardless of this conversation.",
    })
  }

  if (shape.compactions > 0) {
    findings.push({
      id: "timeline.compacted",
      severity: "info",
      title: `This session compacted ${shape.compactions === 1 ? "once" : `${shape.compactions} times`}`,
      detail:
        "Everything before a compaction is a summary, so the sizes above are what the later turns actually carry.",
    })
  }

  return findings
}

export function describeBucket(bucket: Bucket): string {
  switch (bucket) {
    case "user":
      return "what you typed"
    case "assistant":
      return "the agent's own text"
    case "reasoning":
      return "the model's reasoning"
    case "tool-input":
      return "the arguments tools were called with"
    case "tool-output":
      return "what tools returned"
    case "tool-error":
      return "what tools failed with"
    case "file":
      return "files attached to the conversation"
    case "synthetic":
      return "text the harness injected"
    case "other":
      return "everything else"
  }
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(Math.round(count))
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface Interface {
  readonly report: (input: Input) => Effect.Effect<Report, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTimeline") {}

const assistant = sql<string>`json_extract(${MessageTable.data}, '$.role')`
const partType = sql<string>`json_extract(${PartTable.data}, '$.type')`

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const report: Interface["report"] = Effect.fn("SessionTimeline.report")(function* (input: Input) {
      const sessionID = input.sessionID
      const session = yield* db
        .select({ id: SessionTable.id, title: SessionTable.title })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)

      if (!session) return yield* new NotFoundError({ message: `Session not found: ${sessionID}` })

      const rows: Row[] = yield* db
        .select({
          id: PartTable.id,
          messageID: PartTable.message_id,
          role: assistant,
          type: partType,
          data: PartTable.data,
          time: PartTable.time_created,
        })
        .from(PartTable)
        .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
        .where(eq(PartTable.session_id, sessionID))
        .orderBy(asc(PartTable.time_created), asc(PartTable.id))
        .all()
        .pipe(Effect.orDie)

      // The real size of the window: what the provider said it was sent on the
      // most recent turn that actually reported a count. It is the one number
      // here that is not an estimate, and it is what the breakdown is checked
      // against.
      //
      // The window is the uncached input *plus* what was read back from the
      // prompt cache: the cached prefix is still part of the prompt, and it is
      // usually most of it. Reading `tokens.input` alone compares a whole
      // conversation against the small remainder the cache did not cover, which
      // makes the parts look enormous and the report useless.
      const inputTokens = sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.input')`
      const cacheRead = sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.cache.read')`
      const cacheWrite = sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.cache.write')`
      const window = sql<number>`coalesce(${inputTokens}, 0) + coalesce(${cacheRead}, 0) + coalesce(${cacheWrite}, 0)`
      //
      // A turn that reported nothing is skipped rather than taken as the answer:
      // an interrupted or errored turn records zeroes while knowing nothing about
      // the window, and letting it win would make a long conversation read as
      // unmeasured on the strength of its last, broken turn.
      const measured: number | null = yield* db
        .select({ input: window })
        .from(MessageTable)
        .where(and(eq(MessageTable.session_id, sessionID), sql`${assistant} = 'assistant'`, sql`${window} > 0`))
        .orderBy(sql`${MessageTable.time_created} DESC`, sql`${MessageTable.id} DESC`)
        .limit(1)
        .get()
        .pipe(Effect.orDie)
        .pipe(Effect.map((row) => row?.input ?? null))

      const shares = sharesOf(rows)
      const estimated = shares.reduce((total, share) => total + share.tokens, 0)
      const contributors = contributorsOf(rows, input.limit ?? 10)
      for (const contributor of contributors) {
        contributor.share = estimated === 0 ? 0 : contributor.tokens / estimated
      }
      const shape = shapeOf(
        rows,
        rows.map((row) => row.time),
      )
      const coverage: Coverage = {
        measured: measured ?? 0,
        estimated,
        ratio: !measured || measured <= 0 ? 0 : estimated / measured,
      }

      return {
        sessionID: session.id,
        title: session.title,
        shape,
        shares,
        contributors,
        coverage,
        findings: analyze({ shares, contributors, shape, coverage }),
      }
    })

    return Service.of({ report })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })
