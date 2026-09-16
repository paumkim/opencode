import type { Model, Provider } from "@opencode-ai/sdk/v2"

export const MODEL_GROUP_ORDER = [
  "Favorites",
  "Recent",
  "Muse Spark",
  "Best Free Agentic",
  "Fast Free",
  "Reasoning",
  "Paid",
] as const

export type ModelGroup = (typeof MODEL_GROUP_ORDER)[number] | string

export const MODEL_SEARCH_KEYS = ["title", "modelID", "providerID", "providerName", "description", "category", "family", "tags"] as const

type ModelInfoLike = Pick<Model, "id"> &
  Partial<Pick<Model, "name" | "family" | "cost" | "capabilities" | "limit" | "providerID">> & {
    providerName?: string
    description?: string
  }

type ProviderLike = Pick<Provider, "id" | "name"> & {
  description?: string
}

export function isFreeModel(info: { cost?: { input?: number; output?: number } | null }): boolean {
  if (!info.cost) return false
  const input = info.cost.input ?? 0
  const output = info.cost.output ?? 0
  return input === 0 && output === 0
}

export function isMuseSparkModel(info: {
  id?: string
  name?: string | null
  family?: string | null
}): boolean {
  const hay = `${info.id ?? ""} ${info.name ?? ""} ${info.family ?? ""}`.toLowerCase()
  return hay.includes("muse-spark") || hay.includes("muse spark") || hay.includes("musespark")
}

export function smartCategory(info: ModelInfoLike, provider: ProviderLike): string {
  const free = isFreeModel(info)
  const muse = isMuseSparkModel({ id: info.id, name: info.name, family: info.family })
  const reasoning = info.capabilities?.reasoning === true
  const toolcall = info.capabilities?.toolcall === true

  if (muse) return "Muse Spark"
  if (free && toolcall) return "Best Free Agentic"
  if (free) return "Fast Free"
  if (reasoning) return "Reasoning"
  if (provider.id === "opencode") return "Paid"
  return provider.name
}

const GROUP_RANK = new Map<string, number>(MODEL_GROUP_ORDER.map((g, i) => [g, i]))

export function groupRank(category?: string): number {
  if (!category) return Number.MAX_SAFE_INTEGER
  const rank = GROUP_RANK.get(category)
  return rank ?? MODEL_GROUP_ORDER.length
}

export function formatContext(context?: number | null): string | undefined {
  if (!context || context <= 0) return undefined
  if (context >= 1_000_000) {
    const m = context / 1_000_000
    return `${Number.isInteger(m) ? m.toString() : m.toFixed(1)}M`
  }
  if (context >= 1000) return `${Math.round(context / 1000)}k`
  return `${context}`
}

export function formatModelFooter(info: {
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number } | null
  limit?: { context?: number | null } | null
}): string | undefined {
  const ctx = formatContext(info.limit?.context)
  const suffix = ctx ? ` · ${ctx}` : ""
  const free = isFreeModel(info)
  if (free) return `Free${suffix}`
  // The catalog stores per-million-token rates already (e.g. input: 1.75 means
  // $1.75 / 1M tokens). Do NOT multiply again — that is what produced the
  // "$1250000 in / $4250000 out" rows in the picker.
  const input = info.cost?.input
  const output = info.cost?.output
  if (typeof input === "number" && input > 0) {
    const inputPrice = formatPrice(input)
    if (typeof output === "number" && output > 0) {
      const outputPrice = formatPrice(output)
      if (Math.abs(input - output) < 0.001) {
        return `$${inputPrice}/M${suffix}`
      }
      return `$${inputPrice} in / $${outputPrice} out${suffix}`
    }
    return `$${inputPrice}/M${suffix}`
  }
  return ctx
}

/** Catalog cost fields are already per-million tokens. Format for display. */
export function formatPrice(perM: number): string {
  if (!Number.isFinite(perM)) return "—"
  if (perM >= 100) return `${Math.round(perM)}`
  if (perM >= 1) return `${+perM.toFixed(2)}`
  return `${+perM.toFixed(4)}`
}

export function modelTags(
  info: ModelInfoLike,
  provider: ProviderLike,
): string[] {
  const tags: string[] = []
  const free = isFreeModel(info)
  tags.push(free ? "free" : "paid")
  if (info.capabilities?.reasoning) tags.push("reasoning")
  if (info.capabilities?.toolcall) tags.push("agentic", "toolcall")
  if (isMuseSparkModel({ id: info.id, name: info.name, family: info.family })) tags.push("muse")
  if (info.family) tags.push(info.family.toLowerCase())
  tags.push(provider.id.toLowerCase())
  // Add provider name tokens for search
  const providerName = provider.name?.toLowerCase() ?? ""
  const nameTokens = providerName.split(/[^a-z0-9]+/).filter(Boolean)
  tags.push(...nameTokens)
  return tags
}

export interface ModelQueryFilter {
  free?: boolean
  paid?: boolean
  reasoning?: boolean
  agentic?: boolean
  provider?: string
  muse?: boolean
  search: string
}

export function parseModelQuery(needle: string): ModelQueryFilter {
  const tokens = needle.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const filter: ModelQueryFilter = { search: "" }
  const rest: string[] = []
  for (const token of tokens) {
    if (token === "free") filter.free = true
    else if (token === "paid") filter.paid = true
    else if (token === "reasoning") filter.reasoning = true
    else if (token === "agentic" || token === "toolcall" || token === "tools") filter.agentic = true
    else if (token === "muse" || token === "muse-spark" || token === "musespark") filter.muse = true
    else if (token.startsWith("provider:")) {
      const value = token.slice("provider:".length).trim()
      if (value) filter.provider = value
    } else rest.push(token)
  }
  filter.search = rest.join(" ")
  return filter
}

export interface FilterableModelOption {
  providerID?: string
  providerName?: string
  description?: string
  isFree?: boolean
  reasoning?: boolean
  toolcall?: boolean
  modelID?: string
  family?: string
  title?: string
}

export function matchesModelFilter(option: FilterableModelOption, filter: ModelQueryFilter): boolean {
  if (filter.free && !option.isFree) return false
  if (filter.paid && option.isFree) return false
  if (filter.reasoning && !option.reasoning) return false
  if (filter.agentic && !option.toolcall) return false
  if (filter.provider) {
    const hay = (option.providerID ?? "").toLowerCase()
    const nameHay = (option.providerName ?? "").toLowerCase()
    if (!hay.includes(filter.provider) && !nameHay.includes(filter.provider)) return false
  }
  if (filter.muse) {
    const hay = `${option.modelID ?? ""} ${option.title ?? ""} ${option.family ?? ""}`.toLowerCase()
    if (!(hay.includes("muse-spark") || hay.includes("muse spark") || hay.includes("muse") || hay.includes("musespark")))
      return false
  }
  return true
}
