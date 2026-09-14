import { LLMEvent, type ProviderMetadata } from "../../schema"

/**
 * Some models emit chain-of-thought as plain text content instead of a
 * structured reasoning stream. The canonical example is the
 * `thinking` envelope:
 *
 *   thinking
 *   ...internal reasoning...
 *   /thinking
 *
 * opencode's protocol boundary expects `reasoning-*` events, so text-based
 * thinking leaks into the visible transcript and confuses the session
 * processor's loop detectors. This module scans accumulated assistant text for
 * those envelopes and rewrites them into canonical reasoning events.
 */

export interface TextReasoning {
  readonly text: string
  readonly raw: string
}

/** Match one thinking envelope. */
export const ENVELOPE = /<thinking>([\s\S]*?)<\/thinking>/g

/** Match a bare `thinking ... /thinking` block (no tags). */
export const BARE = /thinking\n([\s\S]*?)\/thinking/g

/**
 * Parse accumulated text into reasoning segments. Returns `undefined` when the
 * text contains no thinking envelope so callers can short-circuit.
 */
export const parse = (text: string): TextReasoning[] | undefined => {
  const tagged = [...text.matchAll(ENVELOPE)]
  const bare = [...text.matchAll(BARE)]
  if (tagged.length === 0 && bare.length === 0) return undefined
  const segments: TextReasoning[] = []
  for (const match of tagged) segments.push({ text: match[1], raw: match[0] })
  for (const match of bare) segments.push({ text: match[1], raw: match[0] })
  return segments.length === 0 ? undefined : segments
}

/** Strip thinking envelopes from text, returning the surrounding prose. */
export const strip = (text: string): string =>
  text
    .replace(ENVELOPE, "")
    .replace(BARE, "")
    .replace(/^[ \t]*\n+/, "")
    .replace(/\n+[ \t]*$/, "")
    .trim()

/**
 * Convert parsed reasoning segments into canonical LLM events.
 */
export const toEvents = (
  segments: ReadonlyArray<TextReasoning>,
  providerMetadata?: ProviderMetadata,
): LLMEvent[] => {
  const events: LLMEvent[] = []
  for (const segment of segments) {
    events.push(LLMEvent.reasoningStart({ id: "reasoning-0", providerMetadata }))
    events.push(LLMEvent.reasoningDelta({ id: "reasoning-0", text: segment.text }))
    events.push(LLMEvent.reasoningEnd({ id: "reasoning-0", providerMetadata }))
  }
  return events
}

export const extract = (text: string) => ({
  segments: parse(text),
  text: strip(text),
})

export * as TextReasoning from "./text-reasoning"