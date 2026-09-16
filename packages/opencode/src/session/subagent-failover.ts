import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

export type SubagentModel = { providerID: ProviderV2.ID; modelID: ModelV2.ID }

const COOLDOWN_MS = 10 * 60 * 1000
const cooled = new Map<string, number>()

function key(m: SubagentModel): string {
  return `${m.providerID}/${m.modelID}`
}

export function markSubagentModelFailed(model: SubagentModel): void {
  cooled.set(key(model), Date.now())
}

export function isSubagentModelCooledDown(model: SubagentModel): boolean {
  const since = cooled.get(key(model))
  if (!since) return false
  if (Date.now() - since > COOLDOWN_MS) {
    cooled.delete(key(model))
    return false
  }
  return true
}

export function clearSubagentFailover(): void {
  cooled.clear()
}

// Retryable: quota/rate-limit, network/timeout, overloaded/5xx, and loop-detector bailouts.
// Non-retryable (do NOT rotate): auth, depth limit, unknown agent, permission denials.
export function isRetryableSubagentError(message: string): boolean {
  const hay = message.toLowerCase()
  if (
    hay.includes("depth limit") ||
    hay.includes("unknown agent") ||
    hay.includes("permission") ||
    hay.includes("unauthorized") ||
    hay.includes("invalid api key") ||
    hay.includes("forbidden")
  )
    return false
  return (
    hay.includes("429") ||
    hay.includes("rate limit") ||
    hay.includes("quota") ||
    hay.includes("usage limit") ||
    hay.includes("free limit") ||
    hay.includes("overloaded") ||
    hay.includes("timeout") ||
    hay.includes("timed out") ||
    hay.includes("econnreset") ||
    hay.includes("econnrefused") ||
    hay.includes("fetch failed") ||
    hay.includes("network") ||
    hay.includes("connection") ||
    hay.includes("500") ||
    hay.includes("502") ||
    hay.includes("503") ||
    hay.includes("529") ||
    hay.includes("doom_loop") ||
    hay.includes("doom loop") ||
    hay.includes("loop detected") ||
    hay.includes("subagent failed")
  )
}

function parsePair(raw: string | undefined): SubagentModel | undefined {
  if (!raw) return undefined
  const slash = raw.indexOf("/")
  if (slash <= 0 || slash >= raw.length - 1) return undefined
  return {
    providerID: ProviderV2.ID.make(raw.slice(0, slash)),
    modelID: ModelV2.ID.make(raw.slice(slash + 1)),
  }
}

function envFallbacks(): SubagentModel[] {
  const raw = process.env.OPENCODE_SUBAGENT_FALLBACKS ?? ""
  return raw
    .split(",")
    .map((s) => parsePair(s.trim()))
    .filter((m): m is SubagentModel => !!m)
}

function smallModelFallback(small: SubagentModel | undefined): SubagentModel[] {
  return small ? [small] : []
}

// Build the try-order for a subagent run.
// - Orchestrator (primary) model stays untouched; this only orders subagent attempts.
// - Agent-explicit model goes first, then parent model, then small_model, then env fallbacks.
// - Cooled-down models are skipped unless everything is cooled (then we try anyway).
export function resolveSubagentChain(input: {
  subagentType: string
  parent: SubagentModel
  agentModel?: SubagentModel
  smallModel?: SubagentModel
}): SubagentModel[] {
  void input.subagentType
  const seen = new Set<string>()
  const chain: SubagentModel[] = []
  const push = (m: SubagentModel | undefined) => {
    if (!m) return
    const k = key(m)
    if (seen.has(k)) return
    seen.add(k)
    chain.push(m)
  }
  push(input.agentModel)
  push(input.parent)
  for (const m of smallModelFallback(input.smallModel)) push(m)
  for (const m of envFallbacks()) push(m)
  const fresh = chain.filter((m) => !isSubagentModelCooledDown(m))
  return fresh.length > 0 ? fresh : chain
}

export function buildResumePrompt(input: {
  prompt: string
  attempt: number
  failedModel: SubagentModel
  error: string
}): string {
  if (input.attempt === 0) return input.prompt
  return [
    input.prompt,
    "",
    "---",
    `Resume note (attempt ${input.attempt + 1}): previous attempt with ${key(input.failedModel)} failed: ${input.error.slice(0, 500)}`,
    "The session (task_id) is reused so prior messages are preserved. Verify files on disk before redoing work.",
    "Do ONE task only, checkpoint after each edit, do not loop, do not redo completed verified work.",
  ].join("\n")
}

export * as SubagentFailover from "./subagent-failover"
