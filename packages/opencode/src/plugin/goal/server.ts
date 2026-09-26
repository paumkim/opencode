import type { Plugin } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  accountUsage,
  clearGoal,
  completeGoal,
  createGoal,
  estimateTokensFromText,
  extendGoal,
  formatGoalHistory,
  getGoal,
  markGoalUnmet,
  pauseGoalForPlanMode,
  recordAssistantProgress,
  recordContinuationResult,
  recordPromptAgent,
  reserveContinuation,
  setGoalStatus,
  updateGoalObjective,
} from "@/goal/impl"
import { compactionContext, continuationPrompt, limitPrompt, systemReminder } from "@/goal/prompts"

type Options = {
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

type CreateGoalArgs = {
  objective: string
  token_budget?: number | null
  max_auto_turns?: number | null
  max_duration_seconds?: number | null
}

type ExtendGoalArgs = {
  token_budget?: number | null
  max_auto_turns?: number | null
  max_duration_seconds?: number | null
}

type UpdateGoalArgs =
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

// 0 means unbounded: goals are never capped at a default number of auto-continues.
// An explicit positive `max_auto_turns` plugin option still wins (see positiveIntegerOrNull below).
const DEFAULT_MAX_AUTO_TURNS = 0
const DEFAULT_CONTINUE_INTERVAL_SECONDS = 3
const DEFAULT_MAX_PROMPT_FAILURES = 3
const DEFAULT_RESTRICTED_AGENTS = ["plan"]
const GOAL_SYSTEM_MARKER = "OpenCode goal mode"
const TASK_SETTLE_DELAY_MS = 25
const SNAPSHOT_IDLE_HOLD_MS = 250
const MAX_TIMER_DELAY_MS = 2_147_483_647
const TASK_TERMINAL_STATES = new Set<TaskState>(["completed", "error", "cancelled"])
const PLAN_MODE_CREATE_NOTICE =
  'Goal recorded while the session is in Plan mode, so execution is paused. Do not start implementation work now. Ask the user to switch to Build mode and resume the goal (for example with "/goal resume") to begin execution.'
// Module-scoped so a session cannot be double-continued across plugin instances, but bounded:
// a continuation that never settles (a hung HTTP call — the SDK disables request timeouts) would
// otherwise hold its sessionID forever and silently kill goal mode for that session.
const CONTINUATION_CLAIM_TTL_MS = 120_000
const activeContinuations = new Map<string, number>()

function claimContinuation(sessionID: string) {
  const now = Date.now()
  for (const [id, claimedAt] of activeContinuations) {
    if (now - claimedAt > CONTINUATION_CLAIM_TTL_MS) activeContinuations.delete(id)
  }
  if (activeContinuations.has(sessionID)) return false
  activeContinuations.set(sessionID, now)
  return true
}

function releaseContinuation(sessionID: string) {
  activeContinuations.delete(sessionID)
}

/** Exposed for tests: backdate every claim past the TTL to simulate an aged-out hung call. */
export function staleAllContinuationClaims() {
  const stale = Date.now() - CONTINUATION_CLAIM_TTL_MS - 1_000
  for (const [id, claimedAt] of activeContinuations) {
    activeContinuations.set(id, Math.min(claimedAt, stale))
  }
}

type TaskState = "running" | "completed" | "error" | "cancelled"

type TaskStatus = {
  taskID: string
  state: TaskState
}

type AssistantMarker = {
  id: string | null
  completedAt: number | null
}

type TaskRecord = {
  taskID: string
  parentSessionID: string
  state: TaskState
  terminalUnreconciled: boolean
  terminalAt: number | null
  lastAssistantMessageIDAtTerminal: string | null
}

type SnapshotIdleHold = {
  taskID: string
  parentSessionID: string
  expiresAt: number
}

type TurnWatchdog = {
  timer: ReturnType<typeof setTimeout>
}

function restrictedAgentSet(options?: Options) {
  if (options?.allow_goal_execution_from_plan === true) return new Set<string>()
  const names = Array.isArray(options?.restricted_agents) ? options.restricted_agents : DEFAULT_RESTRICTED_AGENTS
  return new Set(names.map((name) => (typeof name === "string" ? name.trim().toLowerCase() : "")).filter(Boolean))
}

function positiveIntegerOrNull(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

export function resolveCreateGoalLimits(input: CreateGoalArgs, options?: Options) {
  return {
    tokenBudget: Object.hasOwn(input, "token_budget") ? input.token_budget ?? null : options?.default_token_budget ?? null,
    maxAutoTurns: Object.hasOwn(input, "max_auto_turns") ? input.max_auto_turns ?? null : null,
    maxDurationSeconds: Object.hasOwn(input, "max_duration_seconds")
      ? input.max_duration_seconds ?? null
      : options?.max_goal_duration_seconds ?? null,
  }
}

function timeoutMillisecondsFromSeconds(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null
  return Math.min(Math.ceil(value * 1000), MAX_TIMER_DELAY_MS)
}

function textFromPart(part: unknown): string {
  if (!part || typeof part !== "object") return ""
  const value = part as Record<string, unknown>
  if (value.type === "text" && typeof value.text === "string") return value.text
  if (typeof value.content === "string") return value.content
  return ""
}

function textFromMessage(message: { parts?: unknown[] }) {
  return (message.parts ?? []).map(textFromPart).filter(Boolean).join("\n").trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function sessionIDFromMessage(message: { info?: unknown; sessionID?: unknown }) {
  if (typeof message.sessionID === "string") return message.sessionID
  if (isRecord(message.info) && typeof message.info.sessionID === "string") return message.info.sessionID
  return undefined
}

function estimateMessages(messages: { parts?: unknown[] }[]) {
  return messages.reduce<number>((sum, message) => sum + estimateTokensFromText(textFromMessage(message)), 0)
}

function tokensFromRecord(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const tokens = value as Record<string, unknown>
  if (typeof tokens.total === "number") return tokens.total
  const cache = tokens.cache && typeof tokens.cache === "object" ? (tokens.cache as Record<string, unknown>) : {}
  const fields = [tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write]
  if (!fields.some((field) => typeof field === "number")) return undefined
  return fields.reduce<number>((sum, field) => sum + (typeof field === "number" && Number.isFinite(field) ? field : 0), 0)
}

function outputTokensFromRecord(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const output = (value as Record<string, unknown>).output
  return typeof output === "number" && Number.isFinite(output) ? output : undefined
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
  if (message.info && typeof message.info === "object") return tokensFromRecord((message.info as Record<string, unknown>).tokens)
  return undefined
}

function outputTokensFromMessage(message: { info?: unknown; parts?: unknown[] }) {
  let total: number | undefined
  for (const part of message.parts ?? []) {
    if (part && typeof part === "object" && (part as Record<string, unknown>).type === "step-finish") {
      const output = outputTokensFromRecord((part as Record<string, unknown>).tokens)
      if (output != null) total = (total ?? 0) + output
    }
  }
  if (total != null) return total
  if (message.info && typeof message.info === "object") return outputTokensFromRecord((message.info as Record<string, unknown>).tokens)
  return undefined
}

function tokensFromMessages(messages: { info?: unknown; parts?: unknown[] }[]) {
  const exactTotal = messages.reduce<number>((sum, message) => sum + (exactTokensFromMessage(message) ?? 0), 0)
  return exactTotal > 0 ? exactTotal : estimateMessages(messages)
}

function taskHeader(output: string) {
  const resultIndex = output.search(/<task_(?:result|error)>/)
  return resultIndex === -1 ? output : output.slice(0, resultIndex)
}

function parseTaskID(output: string) {
  const xmlMatch = /<task\s+[^>]*\bid=["']([^"']+)["'][^>]*>/i.exec(output)
  if (xmlMatch?.[1]) return xmlMatch[1]
  for (const line of output.split(/\r?\n/)) {
    const match = /^task_id:\s*([^\s()]+)(?:\s*\(.*)?$/i.exec(line.trim())
    if (match?.[1]) return match[1]
  }
  return undefined
}

function parseTaskState(output: string): TaskState | undefined {
  const xmlMatch = /<task\s+[^>]*\bstate=["'](running|completed|error|cancelled)["'][^>]*>/i.exec(output)
  if (xmlMatch?.[1]) return xmlMatch[1].toLowerCase() as TaskState
  for (const line of taskHeader(output).split(/\r?\n/)) {
    const match = /^state:\s*(running|completed|error|cancelled)\s*$/i.exec(line.trim())
    if (match?.[1]) return match[1].toLowerCase() as TaskState
  }
  return undefined
}

function parseTaskStatus(output: unknown): TaskStatus | undefined {
  if (typeof output !== "string") return undefined
  const taskID = parseTaskID(output)
  const state = parseTaskState(output)
  return taskID && state ? { taskID, state } : undefined
}

function messageCompletedAt(message: { info?: unknown; time?: unknown }) {
  const time =
    isRecord(message.time) ? message.time : isRecord(message.info) && isRecord(message.info.time) ? message.info.time : undefined
  const completed = time?.completed
  return typeof completed === "number" && Number.isFinite(completed) ? completed : null
}

function assistantMarker(message: { info?: unknown; role?: unknown; id?: unknown; time?: unknown }): AssistantMarker | undefined {
  if (messageRole(message) !== "assistant") return undefined
  return {
    id: messageID(message) ?? null,
    completedAt: messageCompletedAt(message),
  }
}

function agentFromMessage(message: { info?: unknown } | undefined) {
  if (!message) return undefined
  for (const source of [message, message.info]) {
    if (!isRecord(source)) continue
    for (const key of ["agent", "mode"]) {
      const value = source[key]
      if (typeof value === "string" && value.trim()) return value.trim()
    }
  }
  return undefined
}

async function resolveContinuationModel(
  client: Parameters<Plugin>[0]["client"],
  sessionID: string,
): Promise<{ providerID: string; modelID: string; variant?: string } | undefined> {
  // Inherit the parent session's current model so continuations don't fall back
  // to the agent's hardcoded default (prompt.ts: `input.model ?? ag.model ?? currentModel`).
  try {
    const session = await client.session.get({ path: { id: sessionID } } as never)
    const data = (session as { data?: unknown }).data ?? session
    const info = (data as { info?: unknown }).info ?? data
    const model = (info as { model?: { id?: unknown; providerID?: unknown; variant?: unknown } }).model
    if (model && typeof model.id === "string" && typeof model.providerID === "string") {
      const resolved: { providerID: string; modelID: string; variant?: string } = {
        providerID: model.providerID,
        modelID: model.id,
      }
      if (typeof model.variant === "string" && model.variant && model.variant !== "default") {
        resolved.variant = model.variant
      }
      return resolved
    }
  } catch {
    // Fall through to message-based lookup below.
  }
  try {
    const result = await client.session.messages({ path: { id: sessionID }, query: { limit: 20 } })
    const data = Array.isArray((result as { data?: unknown }).data)
      ? ((result as { data: unknown[] }).data as { info?: unknown; role?: unknown }[])
      : []
    for (const message of [...data].reverse()) {
      const info = (message as { info?: Record<string, unknown> }).info
      const sources = [message as Record<string, unknown>, info]
      for (const source of sources) {
        if (!source || typeof source !== "object") continue
        const model = source["model"] as { providerID?: unknown; modelID?: unknown; id?: unknown } | undefined
        if (model && typeof model.providerID === "string") {
          const modelID = model.modelID ?? model.id
          if (typeof modelID === "string") return { providerID: model.providerID, modelID }
        }
        if (typeof source["providerID"] === "string") {
          const modelID = source["modelID"] ?? source["model"]
          if (typeof modelID === "string") {
            return { providerID: source["providerID"] as string, modelID }
          }
        }
      }
      const variant = (info as { variant?: unknown } | undefined)?.variant
      void variant
    }
  } catch {
    return undefined
  }
  return undefined
}

async function sendContinuation(client: Parameters<Plugin>[0]["client"], sessionID: string, prompt: string, agent?: string | null) {
  let model: { providerID: string; modelID: string } | undefined
  let variant: string | undefined
  try {
    const resolved = await resolveContinuationModel(client, sessionID)
    if (resolved) {
      model = { providerID: resolved.providerID, modelID: resolved.modelID }
      variant = resolved.variant
    }
  } catch {
    model = undefined
  }
  // The SDK does NOT throw on a non-2xx response: without `throwOnError` it resolves to a result
  // tuple carrying `error`. The result must therefore be inspected, or a failed dispatch is
  // indistinguishable from a successful one.
  const result = await client.session.promptAsync({
    path: { id: sessionID },
    body: {
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(variant ? { variant } : {}),
      parts: [{ type: "text", text: prompt }],
    },
  })
  const failure = (result as { error?: unknown } | undefined)?.error
  if (failure) {
    throw new Error(`continuation prompt was rejected: ${errorDetail(failure)}`)
  }
}

function errorDetail(value: unknown) {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function isIdleEvent(event: { type?: string; properties?: Record<string, unknown> }) {
  if (event.type === "session.idle") return true
  const status = event.properties?.status
  return event.type === "session.status" && typeof status === "object" && status !== null && (status as { type?: unknown }).type === "idle"
}

function sessionIDFromEvent(event: { type?: string; properties?: Record<string, unknown> }) {
  const direct = event.properties?.sessionID
  if (typeof direct === "string") return direct
  const info = event.properties?.info
  if (typeof info === "object" && info !== null) {
    if (typeof (info as { sessionID?: unknown }).sessionID === "string") return (info as { sessionID: string }).sessionID
    if (event.type === "session.deleted" && typeof (info as { id?: unknown }).id === "string") {
      return (info as { id: string }).id
    }
  }
  return undefined
}

function messageID(message: { info?: unknown; id?: unknown }) {
  if (typeof message.id === "string") return message.id
  if (message.info && typeof message.info === "object" && typeof (message.info as { id?: unknown }).id === "string") {
    return (message.info as { id: string }).id
  }
  return undefined
}

function messageRole(message: { info?: unknown; role?: unknown }) {
  if (typeof message.role === "string") return message.role
  if (message.info && typeof message.info === "object" && typeof (message.info as { role?: unknown }).role === "string") {
    return (message.info as { role: string }).role
  }
  return undefined
}

function latestAssistantMessage(messages: { info?: unknown; role?: unknown; id?: unknown; parts?: unknown[] }[]) {
  return [...messages].reverse().find((message) => messageRole(message) === "assistant")
}

async function fetchLatestAssistant(client: Parameters<Plugin>[0]["client"], sessionID: string) {
  const result = await client.session.messages({ path: { id: sessionID }, query: { limit: 20 } })
  const data = Array.isArray(result.data) ? result.data : []
  return latestAssistantMessage(data as { info?: unknown; role?: unknown; id?: unknown; parts?: unknown[] }[])
}

async function fetchSessionTokens(client: Parameters<Plugin>[0]["client"], sessionID: string) {
  const result = await client.session.messages({ path: { id: sessionID } })
  const data = Array.isArray(result.data) ? result.data : []
  return tokensFromMessages(data as { info?: unknown; parts?: unknown[] }[])
}

class TaskTracker {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly pendingTaskCalls = new Map<string, string>()
  private readonly latestAssistantBySession = new Map<string, AssistantMarker>()
  private readonly snapshotIdleHolds = new Map<string, SnapshotIdleHold>()
  private readonly settledSnapshotIdleTasks = new Set<string>()

  noteTaskCall(input: { tool?: unknown; sessionID?: unknown; callID?: unknown }) {
    if (typeof input.tool !== "string" || input.tool.toLowerCase() !== "task") return
    if (typeof input.sessionID !== "string") return
    if (typeof input.callID === "string") this.pendingTaskCalls.set(input.callID, input.sessionID)
  }

  noteTaskOutput(input: { tool?: unknown; sessionID?: unknown; callID?: unknown }, output: { output?: unknown } | undefined) {
    if (typeof input.tool !== "string" || input.tool.toLowerCase() !== "task") return
    const parentSessionID =
      typeof input.callID === "string" ? this.pendingTaskCalls.get(input.callID) ?? input.sessionID : input.sessionID
    if (typeof input.callID === "string") this.pendingTaskCalls.delete(input.callID)
    if (typeof parentSessionID !== "string") return
    const status = output?.output === undefined ? undefined : parseTaskStatus(output.output)
    if (!status) return
    if (status.state === "running") {
      this.markRunning(parentSessionID, status.taskID)
      return
    }
    this.markTerminal(status.taskID, status.state, parentSessionID, { resetReconciled: true })
  }

  observeSessionCreated(event: { properties?: Record<string, unknown> }) {
    const info = event.properties?.info
    if (!isRecord(info) || typeof info.id !== "string" || typeof info.parentID !== "string") return
    this.markRunning(info.parentID, info.id)
  }

  observeSessionStatus(sessionID: string, status: string) {
    const task = this.tasks.get(sessionID)
    if (!task) return
    if (status === "busy") {
      this.markRunning(task.parentSessionID, sessionID)
      return
    }
    if (status === "idle") this.markTerminal(sessionID, "completed", task.parentSessionID)
  }

  observeSessionDeleted(sessionID: string) {
    this.tasks.delete(sessionID)
    for (const task of this.tasks.values()) {
      if (task.parentSessionID === sessionID) this.tasks.delete(task.taskID)
    }
    this.latestAssistantBySession.delete(sessionID)
    this.clearSnapshotIdleForSession(sessionID)
  }

  observeMessages(messages: { info?: unknown; role?: unknown; id?: unknown; time?: unknown; parts?: unknown[] }[]) {
    for (const message of messages) {
      const sessionID = sessionIDFromMessage(message)
      if (!sessionID) continue
      const marker = assistantMarker(message)
      if (marker) {
        this.observeAssistant(sessionID, marker)
        continue
      }
      for (const part of message.parts ?? []) {
        const status = parseTaskStatus(textFromPart(part))
        if (!status) continue
        if (status.state === "running") this.markRunning(sessionID, status.taskID)
        else this.markTerminal(status.taskID, status.state, sessionID, { resetReconciled: true })
      }
    }
  }

  observeAssistantMessage(
    sessionID: string,
    message: { info?: unknown; role?: unknown; id?: unknown; time?: unknown } | undefined,
  ) {
    const marker = message ? assistantMarker(message) : undefined
    if (marker) this.observeAssistant(sessionID, marker)
  }

  hasBlockingTasks(parentSessionID: string) {
    this.pruneExpiredSnapshotIdleHolds()
    for (const task of this.tasks.values()) {
      if (task.parentSessionID !== parentSessionID) continue
      if (task.state === "running" || task.terminalUnreconciled) return true
    }
    for (const hold of this.snapshotIdleHolds.values()) {
      if (hold.parentSessionID === parentSessionID) return true
    }
    return false
  }

  nextSnapshotIdleRetryAt(parentSessionID: string) {
    this.pruneExpiredSnapshotIdleHolds()
    let next: number | null = null
    for (const hold of this.snapshotIdleHolds.values()) {
      if (hold.parentSessionID !== parentSessionID) continue
      next = next == null ? hold.expiresAt : Math.min(next, hold.expiresAt)
    }
    return next
  }

  async refreshLiveChildren(client: Parameters<Plugin>[0]["client"], parentSessionID: string) {
    let childIDs: string[]
    try {
      const result = await client.session.children({ path: { id: parentSessionID } })
      // The SDK resolves non-2xx as a result tuple carrying `error` rather than throwing, so the
      // `catch` below does not cover HTTP failures. Treating an error as "no children" would call
      // markAbsentRunningChildren with an empty set and force-clear tasks that are still running.
      if ((result as { error?: unknown } | undefined)?.error) return
      const data = Array.isArray(result.data) ? result.data : []
      childIDs = data.flatMap((child) => (isRecord(child) && typeof child.id === "string" ? [child.id] : []))
    } catch {
      return
    }
    this.markAbsentRunningChildren(parentSessionID, new Set(childIDs))
    if (childIDs.length === 0) return
    let statuses: Record<string, { type?: unknown }>
    try {
      const result = await client.session.status()
      if ((result as { error?: unknown } | undefined)?.error) return
      statuses = isRecord(result.data) ? (result.data as Record<string, { type?: unknown }>) : {}
    } catch {
      return
    }
    for (const childID of childIDs) {
      const status = statuses[childID]
      const statusType = isRecord(status) && typeof status.type === "string" ? status.type : undefined
      if (statusType === "busy") this.markRunning(parentSessionID, childID)
      else if (statusType === "idle") {
        if (this.tasks.has(childID)) this.markTerminal(childID, "completed", parentSessionID)
        else this.markSnapshotIdle(parentSessionID, childID)
      }
    }
  }

  private markRunning(parentSessionID: string, taskID: string) {
    const existing = this.tasks.get(taskID)
    this.clearSnapshotIdle(parentSessionID, taskID)
    this.tasks.set(taskID, {
      taskID,
      parentSessionID,
      state: "running",
      terminalUnreconciled: false,
      terminalAt: null,
      lastAssistantMessageIDAtTerminal: existing?.lastAssistantMessageIDAtTerminal ?? null,
    })
  }

  private markTerminal(
    taskID: string,
    state: TaskState,
    parentSessionID?: string,
    options: { resetReconciled?: boolean } = {},
  ) {
    if (!TASK_TERMINAL_STATES.has(state)) return
    const existing = this.tasks.get(taskID)
    const resolvedParentSessionID = existing?.parentSessionID ?? parentSessionID
    if (!resolvedParentSessionID) return
    this.clearSnapshotIdle(resolvedParentSessionID, taskID)
    if (
      existing &&
      TASK_TERMINAL_STATES.has(existing.state) &&
      !existing.terminalUnreconciled &&
      !options.resetReconciled
    ) {
      return
    }
    this.tasks.set(taskID, {
      taskID,
      parentSessionID: resolvedParentSessionID,
      state,
      terminalUnreconciled: true,
      terminalAt: Date.now(),
      lastAssistantMessageIDAtTerminal: this.latestAssistantBySession.get(resolvedParentSessionID)?.id ?? null,
    })
  }

  private markSnapshotIdle(parentSessionID: string, taskID: string) {
    const key = this.snapshotIdleKey(parentSessionID, taskID)
    if (this.settledSnapshotIdleTasks.has(key) || this.snapshotIdleHolds.has(key)) return
    this.snapshotIdleHolds.set(key, {
      taskID,
      parentSessionID,
      expiresAt: Date.now() + SNAPSHOT_IDLE_HOLD_MS,
    })
  }

  private clearSnapshotIdle(parentSessionID: string, taskID: string) {
    const key = this.snapshotIdleKey(parentSessionID, taskID)
    this.snapshotIdleHolds.delete(key)
    this.settledSnapshotIdleTasks.delete(key)
  }

  private clearSnapshotIdleForSession(sessionID: string) {
    for (const [key, hold] of this.snapshotIdleHolds) {
      if (hold.taskID === sessionID || hold.parentSessionID === sessionID) this.snapshotIdleHolds.delete(key)
    }
    for (const key of this.settledSnapshotIdleTasks) {
      if (key.startsWith(`${sessionID}\0`) || key.endsWith(`\0${sessionID}`)) {
        this.settledSnapshotIdleTasks.delete(key)
      }
    }
  }

  private pruneExpiredSnapshotIdleHolds(now = Date.now()) {
    for (const [key, hold] of this.snapshotIdleHolds) {
      if (hold.expiresAt > now) continue
      this.snapshotIdleHolds.delete(key)
      this.settledSnapshotIdleTasks.add(key)
      const task = this.tasks.get(hold.taskID)
      if (task?.parentSessionID === hold.parentSessionID && task.state === "running") this.tasks.delete(hold.taskID)
    }
  }

  private markAbsentRunningChildren(parentSessionID: string, liveChildIDs: Set<string>) {
    for (const task of this.tasks.values()) {
      if (task.parentSessionID !== parentSessionID || task.state !== "running" || liveChildIDs.has(task.taskID)) continue
      this.markSnapshotIdle(parentSessionID, task.taskID)
    }
  }

  private snapshotIdleKey(parentSessionID: string, taskID: string) {
    return `${parentSessionID}\0${taskID}`
  }

  private observeAssistant(sessionID: string, marker: AssistantMarker) {
    this.latestAssistantBySession.set(sessionID, marker)
    for (const task of this.tasks.values()) {
      if (task.parentSessionID !== sessionID || !task.terminalUnreconciled) continue
      if (this.assistantReconcilesTask(task, marker)) {
        this.tasks.set(task.taskID, { ...task, terminalUnreconciled: false })
      }
    }
  }

  private assistantReconcilesTask(task: TaskRecord, marker: AssistantMarker) {
    if (marker.id && task.lastAssistantMessageIDAtTerminal && marker.id !== task.lastAssistantMessageIDAtTerminal) return true
    if (marker.completedAt != null && task.terminalAt != null && marker.completedAt >= task.terminalAt) return true
    return false
  }
}

async function recordAssistantMessage(
  sessionID: string,
  message: { info?: unknown; role?: unknown; id?: unknown; parts?: unknown[] } | undefined,
  options: Options,
  evaluateContinuation = false,
) {
  if (!message) return
  await recordAssistantProgress(sessionID, {
    messageID: messageID(message),
    text: textFromMessage(message),
    outputTokens: outputTokensFromMessage(message) ?? null,
    noProgressTokenThreshold: positiveIntegerOrNull(options.no_progress_token_threshold),
    maxNoProgressTurns: positiveIntegerOrNull(options.max_no_progress_turns),
    evaluateContinuation,
  })
}

function mergeSystemReminder(output: { system: string[] }, reminder: string) {
  if (!reminder.trim()) return
  if (output.system.some((block) => block.includes(GOAL_SYSTEM_MARKER))) return
  if (output.system.length === 0) {
    output.system.push(reminder)
    return
  }
  output.system[0] = `${output.system[0]}\n\n${reminder}`
}

/**
 * Runs goal bookkeeping without ever propagating its failure. Goal state lives in a
 * user-writable file, so a decode, permission, or disk error must degrade to "goal tracking
 * unavailable" and never fail the prompt, abort a session, or raise an unhandled rejection.
 */
async function goalBookkeeping<T>(operation: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run()
  } catch (error) {
    console.warn(`[goal] ${operation} failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/** Detects the compaction summarizer request, which must not receive goal-continuation instructions. */
function isCompactionRequest(system: string[] | undefined) {
  if (!Array.isArray(system)) return false
  return system.some((block) => {
    if (typeof block !== "string") return false
    const lowered = block.toLowerCase()
    return lowered.includes("compacting agent") || lowered.includes("summarize the conversation")
  })
}

/** Detects the compaction transform, whose message array is a partial history rather than the full one. */
function isCompactionTransform(messages: unknown[]) {
  return messages.some((message) => {
    const info = (message as { info?: unknown } | undefined)?.info
    if (!isRecord(info)) return false
    if (info.summary === true) return true
    return info.mode === "compaction" || info.agent === "compaction"
  })
}

const server: Plugin = async ({ client }, options?: Options) => {
  const autoContinue = options?.auto_continue ?? true
  const deferWhileTasksActive = options?.defer_while_tasks_active ?? true
  const maxAutoTurns = positiveIntegerOrNull(options?.max_auto_turns) ?? DEFAULT_MAX_AUTO_TURNS
  const minInterval = positiveIntegerOrNull(options?.min_continue_interval_seconds) ?? DEFAULT_CONTINUE_INTERVAL_SECONDS
  const maxTurnTimeMs = timeoutMillisecondsFromSeconds(options?.max_turn_time)
  const maxPromptFailures = positiveIntegerOrNull(options?.max_prompt_failures) ?? DEFAULT_MAX_PROMPT_FAILURES
  const taskTracker = new TaskTracker()
  const taskDeferredSessions = new Set<string>()
  const scheduledContinuations = new Map<string, ReturnType<typeof setTimeout>>()
  const turnWatchdogs = new Map<string, TurnWatchdog>()
  const busySessions = new Set<string>()
  const planAgents = restrictedAgentSet(options)
  const isPlanAgent = (agent: unknown) => typeof agent === "string" && planAgents.has(agent.trim().toLowerCase())

  async function createGoalFromTool(input: CreateGoalArgs, context: { sessionID: string; agent?: string }) {
    const planningOnly = isPlanAgent(context.agent)
    const sessionTokensAtCreation = await fetchSessionTokens(client, context.sessionID).catch(() => null)
    const goal = await createGoal(context.sessionID, input.objective, {
      ...resolveCreateGoalLimits(input, options),
      noProgressTokenThreshold: options?.no_progress_token_threshold ?? null,
      maxNoProgressTurns: options?.max_no_progress_turns ?? null,
      agent: typeof context.agent === "string" ? context.agent : null,
      initialStatus: planningOnly ? "paused" : "active",
      sessionTokensAtCreation,
    })
    return JSON.stringify(planningOnly ? { goal, plan_mode_notice: PLAN_MODE_CREATE_NOTICE } : { goal }, null, 2)
  }

  async function taskBlockStatus(sessionID: string) {
    if (!deferWhileTasksActive) return false
    await taskTracker.refreshLiveChildren(client, sessionID)
    return {
      blocked: taskTracker.hasBlockingTasks(sessionID),
      retryAt: taskTracker.nextSnapshotIdleRetryAt(sessionID),
    }
  }

  function clearTurnWatchdog(sessionID: string) {
    const watchdog = turnWatchdogs.get(sessionID)
    if (!watchdog) return
    clearTimeout(watchdog.timer)
    turnWatchdogs.delete(sessionID)
  }

  function armTurnWatchdog(sessionID: string) {
    if (maxTurnTimeMs == null) return
    clearTurnWatchdog(sessionID)
    const watchdog: TurnWatchdog = {
      timer: setTimeout(() => void runTurnWatchdog(sessionID, watchdog), maxTurnTimeMs),
    }
    const maybeUnref = watchdog.timer as { unref?: () => void }
    if (typeof maybeUnref.unref === "function") maybeUnref.unref()
    turnWatchdogs.set(sessionID, watchdog)
  }

  async function runTurnWatchdog(sessionID: string, watchdog: TurnWatchdog) {
    let claimedContinuation = false
    try {
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      const goal = await getGoal(sessionID)
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      if (goal?.status !== "active" || isPlanAgent(goal.lastPromptAgent)) return
      const latestAssistant = await fetchLatestAssistant(client, sessionID)
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      const latestTurnAgent = agentFromMessage(latestAssistant)
      if (isPlanAgent(latestTurnAgent)) return
      const taskStatus = await taskBlockStatus(sessionID)
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      if (taskStatus && taskStatus.blocked) return
      const current = await getGoal(sessionID)
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      if (current?.status !== "active" || isPlanAgent(current.lastPromptAgent) || activeContinuations.has(sessionID)) return

      turnWatchdogs.delete(sessionID)
      if (!claimContinuation(sessionID)) return
      claimedContinuation = true
      await sendContinuation(client, sessionID, continuationPrompt(current), current.lastPromptAgent ?? latestTurnAgent ?? null)
      // A watchdog continuation is a real continuation: it must feed the same failure accounting
      // so repeated rejections trip the circuit breaker instead of failing silently forever.
      await recordContinuationResult(sessionID, "success", maxPromptFailures)
    } catch (error) {
      if (claimedContinuation) {
        try {
          await recordContinuationResult(sessionID, "failure", maxPromptFailures)
        } catch {
          // accounting is best-effort here; never mask the original failure
        }
      }
      try {
        await client.app?.log?.({
          body: {
            service: "opencode-goal-plugin",
            level: "error",
            message: "Turn watchdog retry failed",
            extra: { error: error instanceof Error ? error.message : String(error) },
          },
        })
      } catch {
        return
      }
    } finally {
      if (claimedContinuation) releaseContinuation(sessionID)
      if (turnWatchdogs.get(sessionID) === watchdog) turnWatchdogs.delete(sessionID)
    }
  }

  function scheduleSettledContinuation(sessionID: string, delayMs = TASK_SETTLE_DELAY_MS) {
    if (scheduledContinuations.has(sessionID)) return
    const timer = setTimeout(() => {
      scheduledContinuations.delete(sessionID)
      void runAutoContinue(sessionID, true)
    }, Math.max(0, delayMs))
    const maybeUnref = timer as { unref?: () => void }
    if (typeof maybeUnref.unref === "function") maybeUnref.unref()
    scheduledContinuations.set(sessionID, timer)
  }

  async function runAutoContinue(sessionID: string, fromTaskDeferral = false) {
    if (busySessions.has(sessionID)) return
    if (!claimContinuation(sessionID)) return
    let reserved = false
    try {
      const latestAssistant = await fetchLatestAssistant(client, sessionID)
      taskTracker.observeAssistantMessage(sessionID, latestAssistant)
      const taskStatus = await taskBlockStatus(sessionID)
      if (taskStatus && taskStatus.blocked) {
        taskDeferredSessions.add(sessionID)
        // A running task has no retryAt. Without a bounded poll the deferral is dropped entirely:
        // the only re-entry is the CHILD session's idle event, which resolves to a different
        // sessionID and therefore no-ops. The parent would never resume auto-continue.
        scheduleSettledContinuation(sessionID, taskStatus.retryAt != null ? taskStatus.retryAt - Date.now() : TASK_SETTLE_DELAY_MS)
        return
      }
      if (busySessions.has(sessionID)) return
      await recordAssistantMessage(sessionID, latestAssistant, options ?? {}, true)
      const current = await getGoal(sessionID)
      if (!current) return
      const latestTurnAgent = agentFromMessage(latestAssistant)
      if (isPlanAgent(current.lastPromptAgent) || isPlanAgent(latestTurnAgent)) {
        if (current.status === "active") await pauseGoalForPlanMode(sessionID)
        return
      }
      if (busySessions.has(sessionID)) return
      if (!fromTaskDeferral && taskDeferredSessions.has(sessionID)) {
        scheduleSettledContinuation(sessionID)
        return
      }
      taskDeferredSessions.delete(sessionID)
      const goal = await reserveContinuation(sessionID, maxAutoTurns, minInterval)
      if (!goal) return
      reserved = true
      await sendContinuation(
        client,
        sessionID,
        goal.status === "active" ? continuationPrompt(goal) : limitPrompt(goal),
        goal.lastPromptAgent ?? latestTurnAgent ?? null,
      )
      await recordContinuationResult(sessionID, "success", maxPromptFailures)
    } catch (error) {
      // Only charge the failure ladder once a continuation was actually reserved. A failure while
      // merely observing state (e.g. a transient `session.children` error) is not a failed
      // continuation, and charging it would pause healthy goals.
      if (reserved) {
        try {
          await recordContinuationResult(sessionID, "failure", maxPromptFailures)
        } catch {
          // best-effort accounting must never mask the original failure
        }
      }
      try {
        await client.app?.log?.({
          body: {
            service: "opencode-goal-plugin",
            level: "error",
            message: "Auto-continue failed",
            extra: { error: error instanceof Error ? error.message : String(error) },
          },
        })
      } catch {
        // logging must never replace the original error
      }
    } finally {
      releaseContinuation(sessionID)
    }
  }

  return {
    async dispose() {
      for (const timer of scheduledContinuations.values()) clearTimeout(timer)
      scheduledContinuations.clear()
      for (const watchdog of turnWatchdogs.values()) clearTimeout(watchdog.timer)
      turnWatchdogs.clear()
    },    tool: {
      get_goal: {
        description:
          "Get the current goal for this OpenCode session, including status, observed token usage, elapsed-time usage, budgets, checkpoints, and history.",
        args: {},
        async execute(_args, context) {
          return JSON.stringify({ goal: await getGoal(context.sessionID) }, null, 2)
        },
      },
      get_goal_history: {
        description: "Get the current goal lifecycle history and recent checkpoints for this OpenCode session.",
        args: {},
        async execute(_args, context) {
          const goal = await getGoal(context.sessionID)
          return JSON.stringify({ goal, history_report: formatGoalHistory(goal) }, null, 2)
        },
      },
      create_goal: {
        description:
          "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Fails if a non-complete goal exists. Limits are unlimited by default: omitting a limit arg (or passing null) means no token budget, no auto-continue cap, and no duration cap, so only pass numbers the user explicitly asked for. While the session is in Plan mode, the goal is recorded as paused and execution requires the user to switch to Build mode.",
        args: {
          objective: z.string().min(1).max(4000).describe("The concrete objective to start pursuing."),
          token_budget: z.number().int().positive().nullable().optional().describe("Optional positive token budget. Omit or pass null for unlimited."),
          max_auto_turns: z.number().int().positive().nullable().optional().describe("Optional per-goal auto-continue limit. Omit or pass null for unlimited."),
          max_duration_seconds: z.number().int().positive().nullable().optional().describe("Optional per-goal duration limit. Omit or pass null for unlimited."),
        },
        async execute(args, context) {
          return createGoalFromTool(args as CreateGoalArgs, context)
        },
      },
      set_goal: {
        description:
          "Set a new goal when the user explicitly asks the AGENT to formulate and set its own goal (the model writes the objective itself). Prefer create_goal when passing the user's own words. Fails if a non-complete goal exists. Limits are unlimited by default: omitting a limit arg (or passing null) means no token budget, no auto-continue cap, and no duration cap, so only pass numbers the user explicitly asked for. While the session is in Plan mode, the goal is recorded as paused and execution requires the user to switch to Build mode.",
        args: {
          objective: z.string().min(1).max(4000).describe("The model-formulated concrete objective to start pursuing."),
          token_budget: z.number().int().positive().nullable().optional().describe("Optional positive token budget. Omit or pass null for unlimited."),
          max_auto_turns: z.number().int().positive().nullable().optional().describe("Optional per-goal auto-continue limit. Omit or pass null for unlimited."),
          max_duration_seconds: z.number().int().positive().nullable().optional().describe("Optional per-goal duration limit. Omit or pass null for unlimited."),
        },
        async execute(args, context) {
          return createGoalFromTool(args as CreateGoalArgs, context)
        },
      },
      update_goal_objective: {
        description: "Edit the current OpenCode goal objective when the user explicitly asks to edit or replace it.",
        args: {
          objective: z.string().min(1).max(4000).describe("The updated concrete objective."),
          status: z.enum(["active", "paused"]).optional().describe("Whether the edited goal should be active or paused."),
        },
        async execute(args, context) {
          const input = args as { objective: string; status?: "active" | "paused" }
          const requested = input.status ?? "active"
          const planningOnly = requested === "active" && isPlanAgent(context.agent)
          const goal = await updateGoalObjective(context.sessionID, input.objective, planningOnly ? "paused" : requested, {
            agent: typeof context.agent === "string" ? context.agent : null,
            planModePause: planningOnly,
          })
          return JSON.stringify(planningOnly ? { goal, plan_mode_notice: PLAN_MODE_CREATE_NOTICE } : { goal }, null, 2)
        },
      },
      update_goal: {
        description:
          "Close the existing goal only after an audit against real evidence. Use status complete only when the objective is achieved and no required work remains, and include evidence. Use status unmet only when the objective cannot be achieved or is blocked, and include the blocker. Do not close a goal merely because work is stopping.",
        args: {
          status: z.enum(["complete", "unmet"]).describe("Required. complete means achieved; unmet means blocked or impossible."),
          evidence: z
            .string()
            .min(1)
            .max(4000)
            .optional()
            .describe("Required when status is complete. Summarize the concrete evidence verified."),
          blocker: z
            .string()
            .min(1)
            .max(4000)
            .optional()
            .describe("Required when status is unmet. Explain the concrete blocker or impossibility."),
        },
        async execute(args, context) {
          const input = args as UpdateGoalArgs
          if (input.status === "complete") {
            const goal = await completeGoal(context.sessionID, input.evidence ?? "")
            const budget = goal.tokenBudget == null ? "" : ` Token usage: ${goal.tokensUsed}/${goal.tokenBudget}.`
            const report = `Goal achieved. Time used: ${goal.timeUsedSeconds} seconds.${budget} Evidence: ${goal.completionEvidence}.`
            return JSON.stringify({ goal, completion_report: report }, null, 2)
          }
          const goal = await markGoalUnmet(context.sessionID, input.blocker ?? "")
          const report = `Goal unmet. Time used: ${goal.timeUsedSeconds} seconds. Blocker: ${goal.blocker}.`
          return JSON.stringify({ goal, unmet_report: report }, null, 2)
        },
      },
      extend_goal: {
        description:
          "Explicitly extend the budgets of a goal that stopped at a token, turn, or duration limit. Requires at least one higher limit or a deliberate null for token/duration; preserves usage and history. Closed and ordinary active goals are rejected.",
        args: {
          token_budget: z.number().int().positive().nullable().optional().describe("Higher token budget, or null for no token limit."),
          max_auto_turns: z
            .number()
            .int()
            .positive()
            .nullable()
            .optional()
            .describe("Higher auto-continue limit, or null for no auto-continue limit."),
          max_duration_seconds: z.number().int().positive().nullable().optional().describe("Higher duration limit, or null for no duration limit."),
        },
        async execute(args, context) {
          if (isPlanAgent(context.agent)) {
            throw new Error("cannot extend or reactivate the goal while the session is in Plan mode; switch to Build mode first")
          }
          const input = args as ExtendGoalArgs
          // Pass the SAME configured turn default that runtime enforcement uses, so extension
          // reactivation eligibility can never disagree with enforcement.
          const goal = await extendGoal(
            context.sessionID,
            {
              tokenBudget: input.token_budget,
              maxAutoTurns: input.max_auto_turns,
              maxDurationSeconds: input.max_duration_seconds,
            },
            maxAutoTurns,
          )
          return JSON.stringify({ goal }, null, 2)
        },
      },
      update_goal_status: {
        description:
          "Pause or resume the current OpenCode goal when the user explicitly asks to pause or resume it. Resuming is not allowed while the session is in Plan mode; the user must switch to Build mode first.",
        args: {
          status: z.enum(["active", "paused"]).describe("active resumes a goal; paused pauses it without clearing it."),
        },
        async execute(args, context) {
          const input = args as { status: "active" | "paused" }
          if (input.status === "active" && isPlanAgent(context.agent)) {
            throw new Error(
              "cannot resume the goal while the session is in Plan mode; ask the user to switch to Build mode and resume the goal from there",
            )
          }
          const goal = await setGoalStatus(context.sessionID, input.status, typeof context.agent === "string" ? context.agent : null)
          return JSON.stringify({ goal }, null, 2)
        },
      },
      clear_goal: {
        description: "Clear the current OpenCode goal for this session when the user explicitly asks to clear it.",
        args: {},
        async execute(_args, context) {
          return JSON.stringify({ cleared: await clearGoal(context.sessionID) }, null, 2)
        },
      },
    },
    async "tool.execute.before"(input) {
      taskTracker.noteTaskCall(input as { tool?: unknown; sessionID?: unknown; callID?: unknown })
    },
    async "tool.execute.after"(input, output) {
      taskTracker.noteTaskOutput(
        input as { tool?: unknown; sessionID?: unknown; callID?: unknown },
        output as { output?: unknown },
      )
    },
    async "chat.message"(input, output) {
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : output.message?.sessionID
      const agent = typeof input?.agent === "string" && input.agent.trim() ? input.agent : output.message?.agent
      if (typeof sessionID !== "string" || typeof agent !== "string" || !agent.trim()) return
      await goalBookkeeping("recordPromptAgent", () => recordPromptAgent(sessionID, agent))
    },
    async "experimental.chat.messages.transform"(input, output) {
      taskTracker.observeMessages(output.messages)
      const sessionID =
        "sessionID" in input && typeof input.sessionID === "string"
          ? input.sessionID
          : output.messages.find((message) => typeof message.info.sessionID === "string")?.info.sessionID
      if (!sessionID) return
      // This hook runs inside the LLM step loop. A state read/write failure (unwritable
      // XDG_DATA_HOME, read-only volume) must not fail the user's prompt.
      await goalBookkeeping("accountUsage", () => accountUsage(sessionID, tokensFromMessages(output.messages)))
      // On compaction this hook receives only the compacted-away PREFIX, not the full history.
      // Charging that partial total would corrupt the token cursor and make the next full call
      // charge the entire retained context as fresh usage.
      if (isCompactionTransform(output.messages)) return
      await goalBookkeeping("recordAssistantMessage", () =>
        recordAssistantMessage(sessionID, latestAssistantMessage(output.messages), options ?? {}),
      )
    },
    async "experimental.chat.system.transform"(input, output) {
      if (typeof input.sessionID !== "string") return
      const goal = await goalBookkeeping("getGoal", () => getGoal(input.sessionID as string))
      // The compaction summarizer is a synthetic LLM request. Injecting goal-continuation
      // instructions into it degrades the summary exactly when context is scarcest.
      if (isCompactionRequest(output.system)) return
      mergeSystemReminder(output, systemReminder(goal, { planningOnly: isPlanAgent(goal?.lastPromptAgent) }))
    },
    async "experimental.session.compacting"(input, output) {
      const goal = await goalBookkeeping("getGoal", () => getGoal(input.sessionID))
      if (!goal) return
      output.context.push(compactionContext(goal))
    },
    async "experimental.compaction.autocontinue"(input, output) {
      const goal = await goalBookkeeping("getGoal", () => getGoal(input.sessionID))
      if (goal?.status === "active") output.enabled = false
    },
    async event({ event }) {
      try {
        await handleEvent(event)
      } catch (error) {
        // The plugin loader dispatches this hook with no rejection handler
        // (`void hook.event?.(...)`), so any throw becomes an unhandled rejection.
        console.warn(`[goal] event handling failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }

  async function handleEvent(event: unknown) {
    const sessionID = sessionIDFromEvent(event as never)
      const eventType = (event as { type?: string }).type
      if (eventType === "session.created") {
        taskTracker.observeSessionCreated(event as { properties?: Record<string, unknown> })
      }
      if (sessionID && eventType === "session.status") {
        const status = (event as { properties?: Record<string, unknown> }).properties?.status
        if (isRecord(status) && typeof status.type === "string") {
          if (status.type === "busy") busySessions.add(sessionID)
          if (status.type === "busy") armTurnWatchdog(sessionID)
          if (status.type === "idle") {
            busySessions.delete(sessionID)
            clearTurnWatchdog(sessionID)
          }
          if (status.type === "retry") clearTurnWatchdog(sessionID)
          taskTracker.observeSessionStatus(sessionID, status.type)
        }
      }
      if (sessionID && eventType === "session.idle") {
        busySessions.delete(sessionID)
        clearTurnWatchdog(sessionID)
        taskTracker.observeSessionStatus(sessionID, "idle")
      }
      if (sessionID && eventType === "session.deleted") {
        busySessions.delete(sessionID)
        clearTurnWatchdog(sessionID)
        const scheduled = scheduledContinuations.get(sessionID)
        if (scheduled) clearTimeout(scheduled)
        scheduledContinuations.delete(sessionID)
        taskDeferredSessions.delete(sessionID)
        taskTracker.observeSessionDeleted(sessionID)
      }
      if (sessionID && (event as { type?: string }).type === "message.updated") {
        const props = (event as { properties?: Record<string, unknown> }).properties ?? {}
        const message = [props.info, props.message].find((value) => value && typeof value === "object") as
          | { info?: unknown; role?: unknown; id?: unknown; time?: unknown; parts?: unknown[] }
          | undefined
        taskTracker.observeAssistantMessage(sessionID, message)
        // This hook is dispatched fire-and-forget by the plugin loader with no rejection handler,
        // so a throw here becomes an unhandled rejection. Also: only assistant messages may advance
        // the continuation baseline, or a user/compaction message ID corrupts no-progress detection.
        if (assistantMarker(message ?? {})) {
          await goalBookkeeping("recordAssistantMessage", () =>
            recordAssistantMessage(sessionID, message, options ?? {}),
          )
        }
      }

      if (!autoContinue || !isIdleEvent(event as never)) return
      if (!sessionID) return
      await runAutoContinue(sessionID)
  }
}

export const GOAL_PLUGIN_ID = "local.goal-mode.server"

export default {
  id: GOAL_PLUGIN_ID,
  server,
}
