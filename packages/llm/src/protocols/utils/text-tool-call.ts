import { LLMEvent, type ProviderMetadata } from "../../schema"
import { ProviderShared } from "../shared"

/**
 * Some models emit tool calls as raw text instead of structured `tool_calls`.
 * opencode's protocol boundary expects structured `tool-call` events, so a
 * model that emits text-only tool calls appears to chat forever: the XML
 * leaks into the visible transcript and no tool ever runs.
 *
 * This module scans accumulated assistant text for those envelopes and rewrites
 * them into canonical `tool-call` events. It is deliberately format-plural:
 * different model families use different envelopes, and a harness that only
 * understands one format silently drops every other provider's tools.
 *
 * Supported shapes (each is a separate detector so a partial match on one
 * format never corrupts another):
 *
 * - `dots_function_call` - the canonical dots envelope.
 * - `<tool_call>` JSON - qwen / deepseek / some OpenAI-compatible gateways.
 * - `<function=NAME><parameter=KEY>VALUE` - legacy function-call XML.
 *
 * Every detector runs against the *original* text and the results are merged in
 * a stable order, so a single assistant turn that mixes formats still yields
 * every call exactly once.
 */

export interface TextToolCall {
  readonly name: string
  readonly input: Record<string, unknown>
  readonly raw: string
}

// ---------------------------------------------------------------------------
// dots_function_call envelope
// ---------------------------------------------------------------------------

/** Match one dots_function_call envelope (bare tags, no angle brackets). */
export const ENVELOPE = /dots_function_call([\s\S]*?)\/dots_function_call/g

/** Match one invoke block. */
export const INVOKE = /invoke\s+name="([^"]+)"\s*>([\s\S]*?)\/invoke/g

/** Match one parameter block. */
export const PARAMETER = /parameter\s+name="([^"]+)">\s*([^\n]*(?:\n(?!\/invoke|parameter|invoke)[^\n]*)*)/g

const fromMatch = (invoke: RegExpMatchArray): TextToolCall => {
  const name = invoke[1]
  const params = invoke[2]
  const input: Record<string, unknown> = {}
  for (const param of params.matchAll(PARAMETER)) {
    input[param[1]] = param[2].trim()
  }
  return { name, input, raw: invoke[0] }
}

const parseDots = (text: string): TextToolCall[] => {
  const calls: TextToolCall[] = []
  for (const envelope of text.matchAll(ENVELOPE)) {
    for (const invoke of envelope[1].matchAll(INVOKE)) {
      calls.push(fromMatch(invoke))
    }
  }
  // Bare invoke blocks outside any envelope.
  const stripped = text.replace(ENVELOPE, "")
  for (const invoke of stripped.matchAll(INVOKE)) {
    calls.push(fromMatch(invoke))
  }
  return calls
}

// ---------------------------------------------------------------------------
// <tool_call> JSON envelope (qwen / deepseek / gateways)
// ---------------------------------------------------------------------------

/** Match one `<tool_call>...</tool_call>` JSON block. */
export const TOOL_CALL_TAG = /<tool_call>([\s\S]*?)<\/tool_call>/g

/** Match one bare `<tool_call>{...}` without a close tag (stream tail). */
export const TOOL_CALL_TAG_BARE = /<tool_call>(\{[\s\S]*?\})(?=<tool_call>|$)/g

const parseToolCallTag = (text: string): TextToolCall[] => {
  const calls: TextToolCall[] = []
  const seen = new Set<string>()
  const push = (json: string) => {
    const decoded = ProviderShared.decodeJson(json)
    if (!ProviderShared.isRecord(decoded)) return
    const name = decoded.name
    const args = decoded.arguments
    if (typeof name !== "string") return
    const input = ProviderShared.isRecord(args) ? args : {}
    const raw = JSON.stringify({ name, arguments: input })
    if (seen.has(raw)) return
    seen.add(raw)
    calls.push({ name, input, raw })
  }
  for (const match of text.matchAll(TOOL_CALL_TAG)) push(match[1])
  for (const match of text.matchAll(TOOL_CALL_TAG_BARE)) push(match[1])
  return calls
}

// ---------------------------------------------------------------------------
// <function=NAME><parameter=KEY>VALUE legacy envelope
// ---------------------------------------------------------------------------

/**
 * Match one `<function=NAME>...</function>` block. The close tag is optional:
 * some gateways truncate the final block at the stream boundary, and a
 * parser that requires the close tag silently drops the last call.
 */
export const FUNCTION_TAG = /<function\s+name="([^"]+)"\s*>([\s\S]*?)(?:<\/function>|(?=<function>|$))/g

/**
 * Match one `<parameter=KEY>VALUE` inside a function block. The close tag is
 * optional for the same reason as FUNCTION_TAG: a truncated stream tail must
 * not drop the last parameter of the last call.
 */
export const PARAMETER_TAG = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)(?:<\/parameter>|(?=<\/function>|<function|<parameter|$))/g

const parseFunctionTag = (text: string): TextToolCall[] => {
  const calls: TextToolCall[] = []
  for (const match of text.matchAll(FUNCTION_TAG)) {
    const name = match[1]
    const params = match[2]
    const input: Record<string, unknown> = {}
    for (const param of params.matchAll(PARAMETER_TAG)) {
      input[param[1]] = param[2].trim()
    }
    calls.push({ name, input, raw: match[0] })
  }
  return calls
}

// ---------------------------------------------------------------------------

/**
 * Parse text into zero or more tool calls across every supported envelope.
 * Returns `undefined` when the text contains no envelope so callers can
 * short-circuit.
 */
export const parse = (text: string): TextToolCall[] | undefined => {
  const calls = [...parseDots(text), ...parseToolCallTag(text), ...parseFunctionTag(text)]
  return calls.length === 0 ? undefined : calls
}

/** Strip envelope blocks from text, returning the surrounding prose. */
export const strip = (text: string): string =>
  text
    .replace(ENVELOPE, "")
    .replace(INVOKE, "")
    .replace(TOOL_CALL_TAG, "")
    .replace(TOOL_CALL_TAG_BARE, "")
    .replace(FUNCTION_TAG, "")
    .replace(PARAMETER_TAG, "")
    .replace(/\n{2,}/g, "\n")
    .replace(/^[ \t]*\n+/, "")
    .replace(/\n+[ \t]*$/, "")
    .trim()

/**
 * Convert parsed text tool calls into canonical LLM events.
 */
export const toEvents = (
  calls: ReadonlyArray<TextToolCall>,
  providerMetadata?: ProviderMetadata,
): LLMEvent[] =>
  calls.map((call) =>
    LLMEvent.toolCall({
      id: `${call.name}-${Math.random().toString(36).slice(2, 10)}`,
      name: call.name,
      input: call.input,
      providerMetadata,
    }),
  )

export * as TextToolCall from "./text-tool-call"