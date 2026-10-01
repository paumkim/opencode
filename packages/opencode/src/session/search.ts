export * as SessionSearch from "./search"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { and, desc, eq, sql, type SQL } from "drizzle-orm"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID, SessionID } from "./schema"

/** How much of a matching part to show around the first hit. */
export const SNIPPET_RADIUS = 160

export const Input = Schema.Struct({
  query: Schema.String,
  /** Restrict the search to one conversation. */
  sessionID: Schema.optional(SessionID),
  /**
   * Search every project on the machine instead of just the current one.
   * Without this a search only ever sees the project the command was run in.
   */
  all: Schema.optional(Schema.Boolean),
  /** Fold case on both sides before matching. */
  caseSensitive: Schema.optional(Schema.Boolean),
  /** Include text the harness injected (reminders, compaction output). */
  synthetic: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
})
export type Input = Schema.Schema.Type<typeof Input>

export const Hit = Schema.Struct({
  sessionID: SessionID,
  sessionTitle: Schema.String,
  directory: Schema.String,
  messageID: MessageID,
  partID: PartID,
  role: Schema.String,
  /** `part.time_created`, so hits line up with the message timeline. */
  time: Schema.Finite,
  /** Occurrences of the query inside this part. */
  matches: Schema.Finite,
  /** The window of text around the first hit. */
  snippet: Schema.String,
  /** Offset of `snippet` within the part's full text, so a caller can page back. */
  snippetStart: Schema.Finite,
}).annotate({ identifier: "SessionSearchHit" })
export type Hit = Schema.Schema.Type<typeof Hit>

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

const ELLIPSIS = "…"

const fold = (value: string, caseSensitive: boolean) => (caseSensitive ? value : value.toLowerCase())

/**
 * Offsets of every non-overlapping match of `query` in `text`, counted in code
 * points.
 *
 * The scan walks the original text one character at a time rather than
 * lowercasing the whole string first: `toLowerCase` is not length-preserving
 * (`"İ"` becomes two characters), so folding up front and then slicing the
 * original would put the window in the wrong place.
 */
export function locate(text: string, query: string, caseSensitive = false): number[] {
  const characters = [...text]
  const needle = [...query].map((char) => fold(char, caseSensitive))
  if (needle.length === 0) return []
  const found: number[] = []
  for (let i = 0; i + needle.length <= characters.length; i++) {
    let hit = true
    for (let j = 0; j < needle.length; j++) {
      if (fold(characters[i + j], caseSensitive) !== needle[j]) {
        hit = false
        break
      }
    }
    if (hit) found.push(i)
  }
  return found
}

export interface Snippet {
  /** The window of text, with `…` on whichever side was cut. */
  readonly text: string
  /** Offset of the window in the original text, in UTF-16 units. */
  readonly start: number
  /** Occurrences of the query in the whole part. */
  readonly matches: number
}

/**
 * A window of `text` around the first occurrence of `query`, bounded by code
 * point rather than UTF-16 unit: an emoji at either edge would otherwise be cut
 * in half and leave a lone surrogate in the output. The same correction is made
 * in `truncateToCodePoints` in `@/goal/schema.ts`.
 */
export function snippet(input: {
  text: string
  query: string
  radius?: number
  caseSensitive?: boolean
}): Snippet | undefined {
  const caseSensitive = input.caseSensitive ?? false
  const radius = input.radius ?? SNIPPET_RADIUS
  const characters = [...input.text]
  const matches = locate(input.text, input.query, caseSensitive)
  if (matches.length === 0) return undefined

  const first = matches[0]
  const from = Math.max(0, first - radius)
  const to = Math.min(characters.length, first + [...input.query].length + radius)

  return {
    text: (from > 0 ? ELLIPSIS : "") + characters.slice(from, to).join("") + (to < characters.length ? ELLIPSIS : ""),
    start: characters.slice(0, from).join("").length,
    matches: matches.length,
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const partType = sql<string>`json_extract(${PartTable.data}, '$.type')`
const isSynthetic = sql<number>`coalesce(json_extract(${PartTable.data}, '$.synthetic'), 0)`
const messageRole = sql<string>`json_extract(${MessageTable.data}, '$.role')`

/**
 * The searchable text of a part, whichever kind of part it is.
 *
 * A transcript is mostly *not* prose. The answer to a question is usually in
 * what a tool printed, and the reasoning that led there is not in a text part
 * either. Matching only `type = 'text'` made the substance of a session
 * unsearchable: searching for a value the agent had found and printed in front
 * of you returned nothing, which reads as the tool never having run.
 *
 * A file part stores its contents at `source.text.value`; `source.text` is the
 * `{value,start,end}` envelope around them. Reading the envelope handed
 * `json_extract` an object, which it returns as serialized JSON, so the whole
 * part became one line of `{"value":"...","start":0,"end":47}` with escaped
 * newlines. A query spanning two lines of a file could not match, and the
 * excerpt showed the envelope instead of the code.
 */
const body = sql<string>`case ${partType}
  when 'text' then json_extract(${PartTable.data}, '$.text')
  when 'reasoning' then json_extract(${PartTable.data}, '$.text')
  when 'file' then coalesce(json_extract(${PartTable.data}, '$.text'), json_extract(${PartTable.data}, '$.source.text.value'))
  when 'tool' then coalesce(
    json_extract(${PartTable.data}, '$.state.output'),
    json_extract(${PartTable.data}, '$.state.error'),
    json_extract(${PartTable.data}, '$.state.title')
  )
  else null end`

export interface Interface {
  readonly search: (input: Input) => Effect.Effect<Hit[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSearch") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const search: Interface["search"] = Effect.fn("SessionSearch.search")(function* (input) {
      const query = input.query.trim()
      if (!query) return []

      // `instr` rather than `LIKE`: it takes the query as a literal, so a `%` or
      // `_` in a pasted snippet is searched for instead of acting as a wildcard
      // that matches everything.
      // `body` is non-null only for the part kinds above, so this is the filter
      // that keeps a kind with no searchable text out of the results.
      const conditions: SQL[] = [sql`${body} is not null`, sql`length(${body}) > 0`]
      conditions.push(
        input.caseSensitive ? sql`instr(${body}, ${query}) > 0` : sql`instr(lower(${body}), lower(${query})) > 0`,
      )
      if (!input.synthetic) conditions.push(sql`${isSynthetic} = 0`)
      if (input.sessionID) conditions.push(eq(PartTable.session_id, input.sessionID))
      if (!input.all) {
        const ctx = yield* InstanceState.context
        conditions.push(eq(SessionTable.project_id, ProjectV2.ID.make(ctx.project.id)))
      }

      const cap = input.limit ?? 50
      const rows = yield* db
        .select({
          partID: PartTable.id,
          messageID: PartTable.message_id,
          sessionID: PartTable.session_id,
          time: PartTable.time_created,
          sessionTitle: SessionTable.title,
          directory: SessionTable.directory,
          role: messageRole,
          body,
        })
        .from(PartTable)
        .innerJoin(SessionTable, eq(PartTable.session_id, SessionTable.id))
        .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
        .where(and(...conditions))
        // Every key is a tiebreak, not just a preference. `time_created` has
        // millisecond resolution and a burst of parts written in one turn
        // shares a value, so without the id the order of those rows is whatever
        // SQLite happens to produce — which is how a `--limit` window can show
        // the oldest of a burst instead of the newest.
        .orderBy(desc(SessionTable.time_updated), desc(PartTable.time_created), desc(PartTable.id))
        // Over-fetch, then cut to `cap` below: SQLite's `lower` only folds ASCII,
        // so a row it matched can be one the JS matcher cannot reproduce (and
        // vice versa). Cutting in SQL would silently return fewer than `cap`
        // hits in exactly that case.
        .limit(cap * 2)
        .all()
        .pipe(Effect.orDie)

      const hits: Hit[] = []
      for (const row of rows) {
        // The JS matcher is the authority on where a match is and how many there
        // are; a row it cannot reproduce is dropped rather than rendered as an
        // empty excerpt.
        const found = snippet({ text: row.body, query, caseSensitive: input.caseSensitive })
        if (!found) continue
        hits.push({
          sessionID: row.sessionID,
          sessionTitle: row.sessionTitle,
          directory: row.directory,
          messageID: row.messageID,
          partID: row.partID,
          role: row.role ?? "user",
          time: row.time,
          matches: found.matches,
          snippet: found.text,
          snippetStart: found.start,
        })
        if (hits.length >= cap) break
      }
      return hits
    })

    return Service.of({ search })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })
