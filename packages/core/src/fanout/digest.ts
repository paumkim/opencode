export * as FanoutDigest from "./digest"

import { and, desc, eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { SessionMessageTable } from "../session/sql"
import { SessionSchema } from "../session/schema"

/**
 * A worker's result crosses back to the parent as a digest, never as a
 * transcript.
 *
 * The digest is the child's own last assistant text -- the sentence it would
 * have written had it answered the user directly -- collapsed to one paragraph
 * and bounded. Everything else the child did stays in the child session, where
 * the parent can read it on demand instead of carrying it forever.
 */
export const maxLength = 600

type DatabaseService = Database.Interface["db"]

/** Reads the child's final assistant text, if it produced one. */
export const ofSession = Effect.fn("FanoutDigest.ofSession")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ data: SessionMessageTable.data })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const content = (row?.data as { readonly content?: ReadonlyArray<{ readonly type?: unknown }> } | undefined)?.content
  const text = content
    ?.filter((part) => part.type === "text")
    .flatMap((part) => {
      const value = (part as { readonly text?: unknown }).text
      return typeof value === "string" ? [value] : []
    })
    .at(-1)
  return text === undefined ? undefined : bound(text)
})

/** Collapses a worker's answer to one bounded paragraph. */
export const bound = (text: string, limit = maxLength) => {
  const paragraph = text.replaceAll(/\s+/g, " ").trim()
  if (paragraph.length === 0) return undefined
  if (paragraph.length <= limit) return paragraph
  const clipped = paragraph.slice(0, limit)
  const boundary = clipped.lastIndexOf(" ")
  return `${(boundary > limit / 2 ? clipped.slice(0, boundary) : clipped).trimEnd()}…`
}

/** The digest a failed worker leaves behind, so the parent still learns why. */
export const failure = (error: string) => bound(error, 200) ?? "worker failed without a reason"
