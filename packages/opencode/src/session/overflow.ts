import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"
import { asSchema, type ModelMessage, type Tool } from "ai"
import { Token } from "@/util/token"

export class PreflightError extends Error {
  constructor() {
    super("Outgoing context reached the automatic compaction threshold")
    this.name = "PreflightCompactionError"
  }
}

export function shouldCompactRequest(input: {
  cfg: ConfigV1.Info
  model: Provider.Model
  messages: ModelMessage[]
  tools: Record<string, Tool>
  outputTokenMax?: number
  // Derived from persisted session history before model-message conversion.
  // The conversion appends synthetic user messages after tool results, so a
  // message-derived boundary would miss completed tools and allow replaying
  // their side effects.
  continuation?: boolean
  firstTurn?: boolean
}) {
  const threshold = input.cfg.compaction?.threshold
  if (input.cfg.compaction?.auto === false || input.model.limit.context === 0) return false
  // Use the existing fractional threshold as an explicit opt-in, not a new default.
  if (threshold === undefined || threshold <= 0 || threshold > 1) return false
  // Overflow replay must never discard tool side effects from the current turn.
  if (input.continuation) return false
  // The first turn has no earlier history to compact; replay would reduce the
  // current request's attachments to text labels.
  if (input.firstTurn) return false

  const messages = JSON.stringify(input.messages, function (key, value: unknown) {
    if (key === "reasoningEncryptedContent" && typeof value === "string") return "[opaque reasoning state]"
    if (["data", "url", "image"].includes(key) && ["file", "image", "media"].includes(this?.type)) {
      return "[encoded media]"
    }
    return value
  })
  const tools = JSON.stringify(Object.entries(input.tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: tool.inputSchema ? asSchema(tool.inputSchema).jsonSchema : undefined,
  })))
  // The character estimator undercounts code/JSON relative to provider tokenizers.
  const tokens = Math.ceil((Token.estimate(messages) + Token.estimate(tools)) * 1.3)
  // outputTokenMax is already resolved (including the reasoning buffer) by the
  // caller; do not re-apply the transform here or the reserve doubles.
  const output = input.outputTokenMax ?? ProviderTransform.maxOutputTokens(input.model)
  const reserved = input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, output)
  const capacity = Math.min(
    Math.max(0, input.model.limit.context - output),
    input.model.limit.input ? Math.max(0, input.model.limit.input - reserved) : Infinity,
    Math.floor((input.model.limit.input || input.model.limit.context) * threshold),
  )
  return tokens >= capacity
}

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
