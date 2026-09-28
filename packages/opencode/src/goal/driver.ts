import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { Hooks } from "@opencode-ai/plugin"
import { Effect, Layer, Context } from "effect"
import {
  accountUsage,
  getGoal,
  pauseGoalForPlanMode,
  recordAssistantProgress,
  recordContinuationResult,
  recordPromptAgent,
  readState,
  reserveContinuation,
  setGoalStatus,
} from "@/goal/impl"
import { compactionContext, continuationPrompt, limitPrompt, systemReminder } from "@/goal/prompts"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import {
  goalClient,
  isRecord,
  readGoalOptions,
  restrictedAgentSet,
  textFromMessage,
  textFromPart,
  tokensFromMessages,
  type Client,
  type Options,
} from "@/goal/shared"
import {
  GOAL_DEFAULT_CONTINUE_INTERVAL_SECONDS,
  GOAL_DEFAULT_MAX_AUTO_TURNS,
  GOAL_DEFAULT_MAX_PROMPT_FAILURES,
  GOAL_SYSTEM_MARKER,
  positiveIntegerOrNull,
} from "@/goal/schema"

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

const TASK_SETTLE_DELAY_MS = 25
const SNAPSHOT_IDLE_HOLD_MS = 250
// Ceiling for the deferral poll's backoff. Waiting for a subagent must not cost a fixed number of
// round trips per second: each poll is three of them (`session.messages`, `session.children`,
// `session.status`), so a task left running for twenty minutes was 48,000 polls against the local
// server - precisely the unattended shape goal mode exists for. The ceiling bounds the wait between
// polls at about one per second, which is well under the `min_continue_interval_seconds` the
// continuation itself is throttled by, so the extra latency cannot delay a resumed turn in practice.
const DEFERRAL_MAX_DELAY_MS = 1_000
const MAX_TIMER_DELAY_MS = 2_147_483_647
const TASK_TERMINAL_STATES = new Set<TaskState>(["completed", "error", "cancelled"])
// Module-scoped so a session cannot be double-continued across instances, but bounded:
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

function timeoutMillisecondsFromSeconds(value: unknown) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null
    return Math.min(Math.ceil(value * 1000), MAX_TIMER_DELAY_MS)
  }
  // The config schema declares these as strings, so a configured value arrives as one and the
  // number-only check silently disabled it - `max_turn_time` could be set and did nothing. Accept
  // the duration spellings a user would actually write.
  if (typeof value !== "string") return null
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(value)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return null
  const unit = (match[2] ?? "s").toLowerCase()
  const scale = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000
  return Math.min(Math.ceil(amount * scale), MAX_TIMER_DELAY_MS)
}

function sessionIDFromMessage(message: { info?: unknown; sessionID?: unknown }) {
  if (typeof message.sessionID === "string") return message.sessionID
  if (isRecord(message.info) && typeof message.info.sessionID === "string") return message.info.sessionID
  return undefined
}

function outputTokensFromRecord(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const output = (value as Record<string, unknown>).output
  return typeof output === "number" && Number.isFinite(output) ? output : undefined
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
  if (message.info && typeof message.info === "object")
    return outputTokensFromRecord((message.info as Record<string, unknown>).tokens)
  return undefined
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
  const time = isRecord(message.time)
    ? message.time
    : isRecord(message.info) && isRecord(message.info.time)
      ? message.info.time
      : undefined
  const completed = time?.completed
  return typeof completed === "number" && Number.isFinite(completed) ? completed : null
}

function assistantMarker(message: {
  info?: unknown
  role?: unknown
  id?: unknown
  time?: unknown
}): AssistantMarker | undefined {
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
  client: Client,
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
      return { providerID: model.providerID, modelID: model.id, ...variantRef(model.variant) }
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
        const model = source["model"] as
          | { providerID?: unknown; modelID?: unknown; id?: unknown; variant?: unknown }
          | undefined
        if (model && typeof model.providerID === "string") {
          const modelID = model.modelID ?? model.id
          if (typeof modelID === "string")
            return { providerID: model.providerID, modelID, ...variantRef(model.variant ?? source["variant"]) }
        }
        if (typeof source["providerID"] === "string") {
          const modelID = source["modelID"] ?? source["model"]
          if (typeof modelID === "string") {
            return { providerID: source["providerID"] as string, modelID, ...variantRef(source["variant"]) }
          }
        }
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * A continuation must run on the same model with the same variant as the session it continues, so
 * both resolution paths filter identically. "default" means no variant was chosen, and sending it
 * would pin the model to a variant the session is not using.
 */
function variantRef(variant: unknown) {
  return typeof variant === "string" && variant && variant !== "default" ? { variant } : {}
}

async function sendContinuation(client: Client, sessionID: string, prompt: string, agent?: string | null) {
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
  return (
    event.type === "session.status" &&
    typeof status === "object" &&
    status !== null &&
    (status as { type?: unknown }).type === "idle"
  )
}

/**
 * The server's own per-session status map - `GET /session/status`, one call covering every goal -
 * or null when the lookup failed or came back in a shape this cannot read. Null is what lets a
 * caller fall back to the local event cache rather than guess: "I could not ask" must never be
 * read as "the answer was idle".
 *
 * An empty map is a real answer, not a failure. The server deletes a session's entry when it goes
 * idle, so an empty map means nothing anywhere is busy.
 */
async function fetchSessionStatusMap(client: Client) {
  try {
    const result = await client.session.status()
    // A non-2xx resolves as a result tuple carrying `error` rather than rejecting, so the catch
    // below does not cover HTTP failures.
    if ((result as { error?: unknown } | undefined)?.error) return null
    const data = (result as { data?: unknown } | undefined)?.data
    return isRecord(data) ? (data as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Whether the server says this session is still working, or `null` when the server did not say.
 * Absent means idle: the server drops the entry on idle, which is why its own `get` defaults to
 * `{ type: "idle" }` (`src/session/status.ts`).
 *
 * `retry` counts as working, deliberately, because the local cache treats it that way too - a retry
 * clears the turn watchdog but never removes the session from `busySessions`. A session sitting in
 * a provider backoff is mid-turn, and prompting into it is a second prompt for one turn.
 */
function serverSaysBusy(statusMap: Record<string, unknown> | null, sessionID: string) {
  if (!statusMap) return null
  const status = statusMap[sessionID]
  if (status === undefined) return false
  if (!isRecord(status) || typeof status.type !== "string") return null
  return status.type !== "idle"
}

function sessionIDFromEvent(event: { type?: string; properties?: Record<string, unknown> }) {
  const direct = event.properties?.sessionID
  if (typeof direct === "string") return direct
  const info = event.properties?.info
  if (typeof info === "object" && info !== null) {
    if (typeof (info as { sessionID?: unknown }).sessionID === "string")
      return (info as { sessionID: string }).sessionID
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
  if (
    message.info &&
    typeof message.info === "object" &&
    typeof (message.info as { role?: unknown }).role === "string"
  ) {
    return (message.info as { role: string }).role
  }
  return undefined
}

function latestAssistantMessage(messages: { info?: unknown; role?: unknown; id?: unknown; parts?: unknown[] }[]) {
  return [...messages].reverse().find((message) => messageRole(message) === "assistant")
}

async function fetchLatestAssistant(client: Client, sessionID: string) {
  const result = await client.session.messages({ path: { id: sessionID }, query: { limit: 20 } })
  const data = Array.isArray(result.data) ? result.data : []
  return latestAssistantMessage(data as { info?: unknown; role?: unknown; id?: unknown; parts?: unknown[] }[])
}

class TaskTracker {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly pendingTaskCalls = new Map<string, string>()
  private readonly latestAssistantBySession = new Map<string, AssistantMarker>()
  private readonly snapshotIdleHolds = new Map<string, SnapshotIdleHold>()
  private readonly settledSnapshotIdleTasks = new Set<string>()
  // Tool calls seen per session, reset when the turn is scored. A turn that only ran tools
  // still made progress even when the model wrote no prose.
  private readonly toolCallsBySession = new Map<string, number>()

  noteAnyToolCall(input: { sessionID?: unknown }) {
    if (typeof input.sessionID !== "string") return
    this.toolCallsBySession.set(input.sessionID, (this.toolCallsBySession.get(input.sessionID) ?? 0) + 1)
  }

  /**
   * Tool calls observed since the last SCORED turn. This deletes what it reads, so only the
   * scoring call may use it: `message.updated` and `experimental.chat.messages.transform` observe
   * the same turn without scoring it, and consuming the count there left the scored turn with
   * zero, which made the "a turn with tool calls is progress" rule dead - an unattended refactor
   * that narrates nothing was paused as a stall after two turns.
   */
  takeToolCalls(sessionID: string) {
    const count = this.toolCallsBySession.get(sessionID) ?? 0
    this.toolCallsBySession.delete(sessionID)
    return count
  }

  noteTaskCall(input: { tool?: unknown; sessionID?: unknown; callID?: unknown }) {
    if (typeof input.tool !== "string" || input.tool.toLowerCase() !== "task") return
    if (typeof input.sessionID !== "string") return
    if (typeof input.callID === "string") this.pendingTaskCalls.set(input.callID, input.sessionID)
  }

  noteTaskOutput(
    input: { tool?: unknown; sessionID?: unknown; callID?: unknown },
    output: { output?: unknown } | undefined,
  ) {
    if (typeof input.tool !== "string" || input.tool.toLowerCase() !== "task") return
    const parentSessionID =
      typeof input.callID === "string" ? (this.pendingTaskCalls.get(input.callID) ?? input.sessionID) : input.sessionID
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
    // Released for the same reason as the three above: a deleted session's bookkeeping must not
    // outlive it for the life of the process. Nothing drains either of these once the session is
    // gone, because the only reader is the scoring path for a turn in that same session.
    //
    // This is not only memory. `toolCallsBySession` is read back as PROGRESS credit - any turn
    // with `toolCalls > 0` is scored as work done - so a session ID that is deleted and later
    // reused would have its first stall check waived by a tool call from its previous life, and
    // stall detection would silently not fire. The observation hooks no longer drain this map
    // either: tool-call accounting is consumed only by the scoring call, precisely so the count
    // survives until the turn is judged. Covered by the "deleting a session releases the
    // tool-call credit" test.
    this.toolCallsBySession.delete(sessionID)
    // `pendingTaskCalls` is keyed by call ID and only read to resolve the owning session, so
    // releasing it is retention-only and has no observable behaviour to assert - hence no test
    // for this half. It is not fully sufficient either: a `tool.execute.after` still in flight
    // when the session is deleted resolves its parent from here and re-adds a `tasks` entry for a
    // session that no longer exists. Closing that needs an in-flight guard on the call, not a
    // sweep, so it is left as a known gap rather than half-fixed here.
    for (const [callID, owner] of this.pendingTaskCalls) {
      if (owner === sessionID) this.pendingTaskCalls.delete(callID)
    }
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

  async refreshLiveChildren(client: Client, parentSessionID: string) {
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
      if (task.parentSessionID !== parentSessionID || task.state !== "running" || liveChildIDs.has(task.taskID))
        continue
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
    if (marker.id && task.lastAssistantMessageIDAtTerminal && marker.id !== task.lastAssistantMessageIDAtTerminal)
      return true
    if (marker.completedAt != null && task.terminalAt != null && marker.completedAt >= task.terminalAt) return true
    return false
  }
}

async function recordAssistantMessage(
  sessionID: string,
  message: { info?: unknown; role?: unknown; id?: unknown; parts?: unknown[] } | undefined,
  taskTracker: TaskTracker,
  evaluateContinuation = false,
) {
  if (!message) return
  await recordAssistantProgress(sessionID, {
    messageID: messageID(message),
    text: textFromMessage(message),
    outputTokens: outputTokensFromMessage(message) ?? null,
    // Tool activity counts as progress, but only the SCORING call may consume the count.
    // `takeToolCalls` deletes what it reads, and the two observation hooks (`message.updated` and
    // `experimental.chat.messages.transform`) run while the turn is still in flight, so consuming
    // it there left the scored turn with zero. That made this rule dead in production: an
    // unattended refactor or investigation, which narrates almost nothing, was paused as a stall
    // after two turns of pure tool work. Deriving the count here rather than at each call site
    // keeps the two in step by construction.
    toolCalls: evaluateContinuation ? taskTracker.takeToolCalls(sessionID) : 0,
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

/**
 * The call site declaring that this is the compaction transform. This is the only signal that
 * actually works, and the scan in `isCompactionTransform` is not one:
 *
 * `SessionCompaction.process` hands the hook the compacted-away PREFIX, and it filters prior
 * compaction summaries out of that prefix before the hook fires (`hidden` in `compaction.ts`).
 * So the array a compaction transform receives normally contains no compaction marker at all, the
 * scan returns false, and the prefix is charged as if it were the whole session. That is not
 * self-correcting: the smaller total rewinds `lastSessionTokens`, so the next ordinary turn - which
 * does see the full history - charges the entire retained context as fresh usage, on every
 * compaction. A goal under a token budget therefore exhausted its budget after roughly one
 * compaction no matter how little it had actually spent.
 *
 * Narrowed by hand rather than by widening the public plugin hook type: `Hooks` declares
 * `input: {}`, and an additive optional field there would change the published SDK contract for
 * every plugin to fix a problem only core has.
 */
function isCompactionTransformInput(input: unknown) {
  return typeof input === "object" && input !== null && (input as { compaction?: unknown }).compaction === true
}

/**
 * Fallback identification of a compaction transform by its contents, for a caller that does not
 * pass the marker. Kept because it costs nothing and covers an array that does still carry a
 * compaction message - but it must never be the only check, for the reason above.
 */
function isCompactionTransform(messages: unknown[]) {
  return messages.some((message) => {
    const info = (message as { info?: unknown } | undefined)?.info
    if (!isRecord(info)) return false
    if (info.summary === true) return true
    return info.mode === "compaction" || info.agent === "compaction"
  })
}

export interface Runtime {
  readonly hooks: Hooks
  readonly handleEvent: (event: unknown) => Promise<void>
  /** One pass of the stall re-arm sweep. Exposed so a test can drive it without a real timer. */
  readonly sweepStalledGoals: () => Promise<void>
  readonly dispose: () => Promise<void>
}

/**
 * The per-instance goal driver. It owns the task tracker, the continuation/timer state and the
 * session client, and it exposes the chat/tool hooks the goal feature participates in. The tools
 * themselves live in `@/goal/tools` and are registered as core tools.
 */
export function createGoalRuntime(input: { client: Client; options?: Options }): Runtime {
  const { client } = input
  const options = input.options ?? {}
  const autoContinue = options.auto_continue ?? true
  const deferWhileTasksActive = options.defer_while_tasks_active ?? true
  const maxAutoTurns = positiveIntegerOrNull(options.max_auto_turns) ?? GOAL_DEFAULT_MAX_AUTO_TURNS
  const minInterval =
    positiveIntegerOrNull(options.min_continue_interval_seconds) ?? GOAL_DEFAULT_CONTINUE_INTERVAL_SECONDS
  const maxTurnTimeMs = timeoutMillisecondsFromSeconds(options.max_turn_time)
  const maxStallMs = timeoutMillisecondsFromSeconds(options.max_stall_before_continue)
  // The threshold the stall sweep will actually enforce, or null when it must not run at all.
  // Resolved ONCE and used for the guard, the threshold comparison and the timer, so the three
  // cannot disagree. The sweep dispatches through the same `runAutoContinue` as the idle path, so it
  // is an auto-continuation like any other and `auto_continue: false` has to bind it too. It did
  // not: the idle path checked the opt-out and the sweep only checked for a threshold, so setting
  // both options kept producing continuations while the setting read as "auto-continuation is off".
  // Folding the opt-out in here also stops a deployment that opted out paying for a timer that can
  // only ever do nothing - each tick otherwise reads and decodes the whole global state file just
  // to discover it is not allowed to act.
  const stallSweepMs = autoContinue ? maxStallMs : undefined
  const maxPromptFailures = positiveIntegerOrNull(options.max_prompt_failures) ?? GOAL_DEFAULT_MAX_PROMPT_FAILURES
  const taskTracker = new TaskTracker()
  const taskDeferredSessions = new Set<string>()
  // Consecutive deferrals per session, for the poll backoff. Cleared as soon as the session is no
  // longer blocked, so the next deferral starts at the settle delay again instead of inheriting a
  // long wait from a previous, unrelated stall.
  const deferralAttempts = new Map<string, number>()
  const scheduledContinuations = new Map<string, ReturnType<typeof setTimeout>>()
  const turnWatchdogs = new Map<string, TurnWatchdog>()
  const busySessions = new Set<string>()
  const planAgents = restrictedAgentSet(options)
  const isPlanAgent = (agent: unknown) => typeof agent === "string" && planAgents.has(agent.trim().toLowerCase())

  async function taskBlockStatus(sessionID: string) {
    if (!deferWhileTasksActive) return false
    await taskTracker.refreshLiveChildren(client, sessionID)
    return {
      blocked: taskTracker.hasBlockingTasks(sessionID),
      retryAt: taskTracker.nextSnapshotIdleRetryAt(sessionID),
    }
  }

  /**
   * Re-arms an active goal that has stopped making progress for any reason OTHER than a clean
   * idle event.
   *
   * Every other path into continuation keys on `session.idle`. A turn that ABORTS ends the busy
   * state without ever publishing idle, so no continuation was scheduled: the goal stayed
   * `active`, `autoTurns` stayed 0, and an unattended run sat there doing nothing indefinitely
   * while looking perfectly healthy from the outside. Enumerating the ways a turn can end is
   * fragile, so this does not try - it re-arms any active goal that has been quiet longer than
   * `max_stall_before_continue` and is not already busy, continuing, or scheduled.
   *
   * It routes through `runAutoContinue`, so the throttle, the plan-agent guard, task deferral and
   * the prompt-failure ladder all still apply. That last one is what stops a session whose turns
   * abort deterministically from hot-looping: each re-arm that fails counts as a continuation
   * failure and the goal eventually self-pauses.
   *
   * "Is this session still working" is asked of the SERVER, never of the local busy cache - see
   * the guard inside for why that distinction is the whole fix.
   */
  async function sweepStalledGoals() {
    if (stallSweepMs == null) return
    const now = Math.floor(Date.now() / 1000)
    const state = await goalBookkeeping("readState", () => readState())
    if (!state) return
    const active = Object.values(state.goals).filter((goal) => goal.status === "active")
    // Hoisted out of the loop so the round trip below is not paid by a deployment that never
    // opened a goal: the timer is armed by `max_stall_before_continue` alone and runs forever.
    if (active.length === 0) return
    // ONE status lookup for every goal below - cheaper than the per-goal `client.session.get` this
    // sweep already makes - and fetched up here rather than inside the loop so that handling a
    // missing or unusable answer is written once instead of once per goal.
    const statusMap = await fetchSessionStatusMap(client)
    for (const goal of active) {
      const sessionID = goal.sessionID
      // The local `busySessions` set is NOT authority on whether this session is still working, and
      // asking it here is what left this sweep unable to fire in the one case it exists for.
      //
      // It is a cache of EVENTS: an entry goes in on a `session.status` event reporting `busy` and
      // comes out only on an idle event or a delete. The failure this sweep was written for is a
      // turn that ABORTS - observed live, aborting inside session compaction - which ends the busy
      // state without ever publishing idle. Under exactly that hypothesis the clearing event never
      // arrives, so the cache holds the session forever and this guard skips it forever: the set
      // re-creates the condition the sweep exists to detect, and the guard is why the net could not
      // catch it. The goal then reads as perfectly healthy from the outside - `status: active`,
      // `autoTurns: 0`, `lastStatus: "Goal set."`, `noProgressTurns: 0/8` - while doing nothing at
      // all, 351s past a 5m `max_stall_before_continue` with nothing left to re-arm it (the turn
      // watchdog is inert here by design: `max_turn_time` was unset, only the stall threshold set).
      //
      // The server's status map is the authority that does not depend on an event arriving. It is
      // answered from live in-memory state, an aborted turn is absent from it, and the answer then
      // contradicts the cache - which is the rescue path, and the reason this fix exists.
      //
      // `null` means the server gave no readable answer, and then the cache is the only evidence
      // there is. Its answer is the conservative one, so a failed lookup can only ever skip a goal,
      // never dispatch into a session that is genuinely working.
      if (serverSaysBusy(statusMap, sessionID) ?? busySessions.has(sessionID)) continue
      // Reached only when the server says this session is NOT working, or said nothing and the
      // cache already agreed. A local entry that contradicts the server is not "probably wrong":
      // the server watched the turn end, so the entry is stale. It has to be DROPPED here, not just
      // overruled for one call, because `runAutoContinue` - the dispatch this re-arm routes
      // through - re-checks the same cache before it prompts, as do the idle path and the watchdog.
      // Overruling it for a single call would skip the re-arm and rebuild the deadlock one call
      // deeper; dropping it also stops the rest of the process believing a lie about the session.
      busySessions.delete(sessionID)
      if (activeContinuations.has(sessionID)) continue
      if (scheduledContinuations.has(sessionID)) continue
      // Compared as a FRACTION of a second, not floored to whole seconds. Flooring turned every
      // sub-second threshold into zero - `Math.floor(500 / 1000)` is 0 - so the guard became
      // `age < 0`, never fired, and every active goal looked stale. `timeoutMillisecondsFromSeconds`
      // accepts `ms`, so "500ms" is a value a user can write and it was silently meaning "always".
      if (now - goal.updatedAt < stallSweepMs / 1000) continue

      // Whether the session is still alive matters: re-arming a goal whose session is gone is how a
      // long-lived state file fills with live-looking goals that quietly burn an auto-turn every
      // threshold forever, and a dispatch to a missing session is not recorded as a prompt failure,
      // so the ladder never trips and the loop is self-sustaining.
      //
      // But a FAILED lookup is AMBIGUOUS, and must not be resolved destructively. The goal state
      // file is GLOBAL - `statePath()` has no directory component - while this runtime's client is
      // directory-scoped, and a goal carries no project identity of its own, so this sweep cannot
      // tell its own goals from another project's. Every session belonging to another project 404s
      // here exactly like a deleted one does. Retiring on that ambiguity means opening a second
      // project can PAUSE a live unattended goal belonging to the first, silently, and precisely in
      // the long runs where a spurious pause does the most damage.
      //
      // So an ambiguous lookup leaves the goal alone. The cost is that a genuinely dead session's
      // goal is no longer auto-retired - the pre-existing behaviour, which merely leaves a stale
      // entry that is visible and hand-clearable. Trading a silent pause of someone else's live goal
      // for a stale row is the right way round. The real fix is to record the owning directory on
      // each goal so the sweep can scope itself; that is a persisted-schema change and an owner's
      // call, not a minimal fix.
      const session = await Promise.resolve(client.session.get({ path: { id: sessionID } } as never)).catch(
        () => null,
      )
      const info = (session as { data?: { info?: unknown } } | null)?.data?.info
      // No console output here. The sweep visits EVERY active goal in the global state file on
      // every tick, so a line per goal is a line every few seconds on the user's TUI - noise that
      // looks alarming and reports nothing actionable, since the outcome is deliberately "do
      // nothing". Whether each goal's session is alive is observable via get_goal when it matters.
      if (!info || typeof (info as { id?: unknown }).id !== "string") continue

      // Deliberately NOT logged to the console. This runs on every sweep for every active goal,
      // and a per-sweep line on the TUI is alarming noise that says nothing the goal state does not
      // already record - `runAutoContinue` writes the reservation to `lastStatus` and history.
      // Only the retirement below is worth interrupting the user for, because it changes what a
      // goal claims about itself.
      await runAutoContinue(sessionID)
    }
  }

  /**
   * Cadence is a fraction of the stall threshold so detection lands close to the threshold without
   * busy-polling, and never drops below 15s so a small threshold cannot turn into a hot loop.
   */
  const stallTimer = (() => {
    if (stallSweepMs == null) return undefined
    const cadence = Math.max(15_000, Math.min(120_000, Math.floor(stallSweepMs / 4)))
    const timer = setInterval(() => void sweepStalledGoals(), cadence)
    const maybeUnref = timer as { unref?: () => void }
    if (typeof maybeUnref.unref === "function") maybeUnref.unref()
    return timer
  })()

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
      if (current?.status !== "active" || isPlanAgent(current.lastPromptAgent) || activeContinuations.has(sessionID))
        return

      turnWatchdogs.delete(sessionID)
      if (!claimContinuation(sessionID)) return
      claimedContinuation = true
      await sendContinuation(
        client,
        sessionID,
        continuationPrompt(current),
        current.lastPromptAgent ?? latestTurnAgent ?? null,
      )
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
            service: "opencode-goal",
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
    const timer = setTimeout(
      () => {
        scheduledContinuations.delete(sessionID)
        void runAutoContinue(sessionID, true)
      },
      Math.max(0, delayMs),
    )
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
        // A running task has no retryAt. Without a bounded poll the deferral is dropped entirely:
        // the only re-entry is the CHILD session's idle event, which resolves to a different
        // sessionID and therefore no-ops. The parent would never resume auto-continue.
        //
        // The poll's delay backs off across consecutive defersrals of the SAME session rather than
        // staying at the settle delay, so the cost of waiting on a long task is bounded instead of
        // linear in its duration. A snapshot-idle hold is a different case and keeps its own timing:
        // one expires within SNAPSHOT_IDLE_HOLD_MS, so there is nothing to wait out.
        const deferrals = (deferralAttempts.get(sessionID) ?? 0) + 1
        deferralAttempts.set(sessionID, deferrals)
        taskDeferredSessions.add(sessionID)
        scheduleSettledContinuation(
          sessionID,
          taskStatus.retryAt != null
            ? Math.max(taskStatus.retryAt - Date.now(), 0)
            : Math.min(TASK_SETTLE_DELAY_MS * 2 ** (deferrals - 1), DEFERRAL_MAX_DELAY_MS),
        )
        return
      }
      if (busySessions.has(sessionID)) return
      await recordAssistantMessage(sessionID, latestAssistant, taskTracker, true)
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
      // Not blocked any more, so the next deferral of this session starts at the settle delay
      // again rather than inheriting a long backoff from this stall.
      deferralAttempts.delete(sessionID)
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
            service: "opencode-goal",
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
      deferralAttempts.delete(sessionID)
      taskTracker.observeSessionDeleted(sessionID)
    }
    if (sessionID && (event as { type?: string }).type === "message.updated") {
      const props = (event as { properties?: Record<string, unknown> }).properties ?? {}
      const message = [props.info, props.message].find((value) => value && typeof value === "object") as
        | { info?: unknown; role?: unknown; id?: unknown; time?: unknown; parts?: unknown[] }
        | undefined
      taskTracker.observeAssistantMessage(sessionID, message)
      // The event is dispatched fire-and-forget by the subscription with no rejection handler,
      // so a throw here becomes an unhandled rejection. Also: only assistant messages may advance
      // the continuation baseline, or a user/compaction message ID corrupts no-progress detection.
      if (assistantMarker(message ?? {})) {
        await goalBookkeeping("recordAssistantMessage", () =>
          recordAssistantMessage(sessionID, message, taskTracker),
        )
      }
    }

    if (!autoContinue || !isIdleEvent(event as never)) return
    if (!sessionID) return
    await runAutoContinue(sessionID)
  }

  const hooks: Hooks = {
    async event(input) {
      await handleGoalEvent(input.event, { handle: handleEvent })
    },
    async dispose() {
      for (const timer of scheduledContinuations.values()) clearTimeout(timer)
      scheduledContinuations.clear()
      for (const watchdog of turnWatchdogs.values()) clearTimeout(watchdog.timer)
      turnWatchdogs.clear()
      if (stallTimer) clearInterval(stallTimer)
    },
    async "tool.execute.before"(input) {
      taskTracker.noteAnyToolCall(input as { sessionID?: unknown })
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
      // On compaction this hook receives only the compacted-away PREFIX, not the full history, so
      // its total is SMALLER than the token cursor. `accountUsage` differences against that cursor,
      // so charging a smaller total leaves the delta at zero but still rewinds the cursor - and the
      // next full transform then charges the entire retained context as fresh usage, on every
      // compaction. The guard therefore has to come BEFORE `accountUsage`, which is the call that
      // moves the cursor. It also covers the assistant-progress call below, for the same reason: a
      // prefix is not the session's latest assistant message and must not become a progress
      // baseline. The marker the call site passes is the signal that works - the prefix has its
      // compaction markers stripped, so the array itself cannot be trusted to identify this call.
      if (isCompactionTransformInput(input) || isCompactionTransform(output.messages)) return
      // This hook runs inside the LLM step loop. A state read/write failure (unwritable
      // XDG_DATA_HOME, read-only volume) must not fail the user's prompt.
      await goalBookkeeping("accountUsage", () => accountUsage(sessionID, tokensFromMessages(output.messages)))
      await goalBookkeeping("recordAssistantMessage", () =>
        recordAssistantMessage(sessionID, latestAssistantMessage(output.messages), taskTracker),
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
      // Same rule `systemReminder` applies, for the same reason: a complete or unmet goal must not
      // be handed more goal-continuation instructions. `compactionContext` is written for a goal
      // still in flight - it tells the summariser to preserve the objective, the budget and the
      // latest checkpoint, and to "close with update_goal status complete only with evidence" -
      // which is instruction to do already-finished work, delivered to the summariser at exactly
      // the moment context is scarcest. A live goal's context is the mechanism that carries the
      // objective across compaction, so this guard must not extend past closed goals.
      if (goal.status === "complete" || goal.status === "unmet") return
      output.context.push(compactionContext(goal))
    },
    async "experimental.compaction.autocontinue"(input, output) {
      const goal = await goalBookkeeping("getGoal", () => getGoal(input.sessionID))
      // `compaction.ts` appends a synthetic user message and keeps the session running whenever
      // `enabled` survives this hook. An ACTIVE goal already drives its own continuation from the
      // idle event, so leaving this on would give it two continuations per compaction. Scoped to
      // `active` on purpose: a limited goal's single wrap-up is sent behind `budgetWrapupSent`, and
      // a goal's limits bound the goal's own auto-continues, not the user's session, so every other
      // status is left to the session. Pinned both ways by the H26 tests so widening it is a
      // deliberate edit rather than a silent scope change.
      if (goal?.status === "active") output.enabled = false
    },
  }

  return {
    hooks,
    handleEvent: (event: unknown) => handleGoalEvent(event, { handle: handleEvent }),
    sweepStalledGoals: () => sweepStalledGoals(),
    dispose: () => Promise.resolve(hooks.dispose?.()),
  }
}

/**
 * Dispatches one core event into the goal driver. The subscription that calls this runs
 * fire-and-forget with no rejection handler, so any throw must degrade to a warning.
 */
export async function handleGoalEvent(event: unknown, options: { handle: (event: unknown) => Promise<void> }) {
  try {
    await options.handle(event)
  } catch (error) {
    console.warn(`[goal] event handling failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly deps: () => Effect.Effect<{ client: Client; options: Options }>
  readonly trigger: (name: string, input: unknown, output: unknown) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GoalDriver") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service

    const state = yield* InstanceState.make<{ client: Client; options: Options; runtime: Runtime }>(
      Effect.fn("GoalDriver.state")(function* (ctx) {
        const options = readGoalOptions(yield* config.get())
        const client = yield* goalClient(ctx.directory)
        const runtime = createGoalRuntime({ client, options })

        // Per-instance subscription on the same event service the plugin used, so directory
        // filtering and the instance-scoped lifetime are preserved. The scope is the instance
        // cache's scope, so the listener is torn down when the instance is disposed.
        const unsubscribe = yield* events.listen((event) => {
          if (event.location?.directory !== ctx.directory) return Effect.void
          return Effect.sync(() => {
            void runtime.handleEvent({ id: event.id, type: event.type, properties: event.data })
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()))

        return { client, options, runtime }
      }),
    )

    const init = Effect.fn("GoalDriver.init")(function* () {
      yield* InstanceState.get(state)
    })

    const deps = Effect.fn("GoalDriver.deps")(function* () {
      const s = yield* InstanceState.get(state)
      return { client: s.client, options: s.options }
    })

    // Goal hooks are dispatched from core, not from a plugin, so `disableDefaultPlugins` cannot
    // remove them. External plugins still run afterwards, matching the previous ordering where the
    // goal plugin was registered before any externally loaded plugin.
    const trigger = Effect.fn("GoalDriver.trigger")(function* (name: string, input: unknown, output: unknown) {
      const hook = (yield* InstanceState.get(state)).runtime.hooks[name as keyof Hooks]
      if (typeof hook !== "function") return
      yield* Effect.promise(async () => (hook as (input: unknown, output: unknown) => Promise<void>)(input, output))
    })

    return Service.of({ init, deps, trigger })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [EventV2Bridge.node, Config.node],
})

export * as GoalDriver from "./driver"
