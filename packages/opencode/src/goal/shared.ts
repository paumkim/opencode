import { createOpencodeClient } from "@opencode-ai/sdk"
import type { Plugin } from "@opencode-ai/plugin"
import { Effect } from "effect"
import { positiveIntegerOrNull } from "@/goal/schema"
import { ServerAuth } from "@/server/auth"

export type Client = Parameters<Plugin>[0]["client"]

export type Options = {
  auto_continue?: boolean
  defer_while_tasks_active?: boolean
  max_auto_turns?: number
  min_continue_interval_seconds?: number
  max_turn_time?: number
  max_prompt_failures?: number
  default_token_budget?: number
  max_goal_duration_seconds?: number
  no_progress_token_threshold?: number
  max_no_progress_turns?: number
  restricted_agents?: string[]
  allow_goal_execution_from_plan?: boolean
}

export type CreateGoalArgs = {
  objective: string
  token_budget?: number | null
  max_auto_turns?: number | null
  max_duration_seconds?: number | null
  no_progress_token_threshold?: number | null
  max_no_progress_turns?: number | null
  max_prompt_failures?: number | null
}

export type ExtendGoalArgs = {
  token_budget?: number | null
  max_auto_turns?: number | null
  max_duration_seconds?: number | null
}

export type UpdateGoalArgs =
  | {
      status: "complete"
      evidence?: string
      blocker?: string
    }
  | {
      status: "unmet"
      evidence?: string
      blocker?: string
    }

/**
 * Backward compatibility: goal mode used to be an internal plugin, so its options live under
 * `config.plugin_options["local.goal-mode.server"]`. The feature is now core, but the key is kept
 * verbatim so existing opencode.json files keep working.
 */
export const CONFIG_KEY = "local.goal-mode.server"

const DEFAULT_RESTRICTED_AGENTS = ["plan"]

export function readGoalOptions(cfg: { plugin_options?: unknown }) {
  const configured = (cfg.plugin_options as Record<string, Record<string, unknown>> | undefined)?.[CONFIG_KEY]
  return (configured ?? {}) as Options
}

export function restrictedAgentSet(options?: Options) {
  if (options?.allow_goal_execution_from_plan === true) return new Set<string>()
  const names = Array.isArray(options?.restricted_agents) ? options.restricted_agents : DEFAULT_RESTRICTED_AGENTS
  return new Set(names.map((name) => (typeof name === "string" ? name.trim().toLowerCase() : "")).filter(Boolean))
}

export function resolveCreateGoalLimits(input: CreateGoalArgs, options?: Options) {
  return {
    tokenBudget: Object.hasOwn(input, "token_budget")
      ? (input.token_budget ?? null)
      : (options?.default_token_budget ?? null),
    maxAutoTurns: Object.hasOwn(input, "max_auto_turns") ? (input.max_auto_turns ?? null) : null,
    maxDurationSeconds: Object.hasOwn(input, "max_duration_seconds")
      ? (input.max_duration_seconds ?? null)
      : (options?.max_goal_duration_seconds ?? null),
  }
}

/**
 * The goal runtime talks to sessions through the HTTP SDK client, exactly as the plugin did.
 * `../server/server` is imported dynamically for the same reason the plugin loader does: the
 * server pulls in the tool registry, so a static import would close an import cycle.
 */
export function goalClient(directory: string) {
  return Effect.gen(function* () {
    const { Server } = yield* Effect.promise(() => import("@/server/server"))
    const serverUrl = Server.url
    return createOpencodeClient({
      baseUrl: serverUrl?.toString() ?? "http://localhost:4096",
      directory,
      headers: ServerAuth.headers(),
      ...(serverUrl ? {} : { fetch: async (...args) => Server.Default().app.fetch(...args) }),
    })
  })
}

export * as GoalShared from "./shared"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function textFromPart(part: unknown): string {
  if (!part || typeof part !== "object") return ""
  const value = part as Record<string, unknown>
  if (value.type === "text" && typeof value.text === "string") return value.text
  if (typeof value.content === "string") return value.content
  return ""
}

export function textFromMessage(message: { parts?: unknown[] }) {
  return (message.parts ?? []).map(textFromPart).filter(Boolean).join("\n").trim()
}

function tokensFromRecord(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const tokens = value as Record<string, unknown>
  if (typeof tokens.total === "number") return tokens.total
  const cache = tokens.cache && typeof tokens.cache === "object" ? (tokens.cache as Record<string, unknown>) : {}
  const fields = [tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write]
  if (!fields.some((field) => typeof field === "number")) return undefined
  return fields.reduce<number>(
    (sum, field) => sum + (typeof field === "number" && Number.isFinite(field) ? field : 0),
    0,
  )
}

function exactTokensFromPart(part: unknown): number | undefined {
  if (!part || typeof part !== "object") return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  return tokensFromRecord(value.tokens)
}

function exactTokensFromMessage(message: { info?: unknown; parts?: unknown[] }) {
  const partTotal = (message.parts ?? []).reduce<number>((sum, part) => sum + (exactTokensFromPart(part) ?? 0), 0)
  if (partTotal > 0) return partTotal
  if (message.info && typeof message.info === "object")
    return tokensFromRecord((message.info as Record<string, unknown>).tokens)
  return undefined
}

/**
 * Cumulative session tokens, from the provider's own accounting only.
 *
 * A text estimate is deliberately NOT substituted when the provider reports nothing. `accountUsage`
 * differences each observation against the previous one, so the cursor is a running total, and an
 * estimate and a provider count are not the same unit: seeding the cursor with an estimate and
 * then differencing the first real count against it charges `max(0, real - estimate)`, which is 0
 * whenever the estimate is the larger of the two. A turn that really spent tokens was charged
 * nothing, so a budget goal silently under-counted and never reached its limit. Only assistant
 * messages carry a step-finish part, so the first observation of a session was exactly the
 * estimated one and every later one was exact - making that transition the common case, not an edge
 * case. A provider that reports no usage now reports none to the goal, which is honest.
 */
export function tokensFromMessages(messages: { info?: unknown; parts?: unknown[] }[]) {
  return messages.reduce<number>((sum, message) => sum + (exactTokensFromMessage(message) ?? 0), 0)
}
