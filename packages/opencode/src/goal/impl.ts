import { existsSync, mkdirSync, renameSync } from "node:fs"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { legacyStateFile, statePath } from "@opencode-ai/core/goal/path"
import type {
  AssistantProgressInput,
  CreateGoalOptions,
  ExtendGoalOptions,
  Goal,
  GoalHistoryType,
  GoalSnapshot,
  State,
} from "./schema"
import {
  GOAL_CHECKPOINT_CHAR_LIMIT,
  GOAL_DEFAULT_MAX_NO_PROGRESS_TURNS,
  GOAL_DEFAULT_MAX_AUTO_TURNS,
  GOAL_DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD,
  GOAL_HISTORY_LIMIT,
  GOAL_CHECKPOINT_LIMIT,
  GOAL_MAX_RETAINED_TEXT,
  positiveIntegerOrNull,
  withinCharacterLimit,
  truncateToCodePoints,
  GOAL_MAX_EVIDENCE,
  GOAL_MAX_OBJECTIVE,
  StateSchema,
  GoalError,
} from "./schema"
import { Data, Effect, Schema } from "effect"

export * as GoalState from "./schema"

class StateReadError extends Data.TaggedError("StateReadError")<{ readonly cause: unknown }> {}
class StateDecodeError extends Data.TaggedError("StateDecodeError")<{ readonly cause: unknown }> {}
class StateWriteError extends Data.TaggedError("StateWriteError")<{ readonly cause: unknown }> {}

/* ------------------------------------------------------------------ */
/* State file                                                          */
/* ------------------------------------------------------------------ */

/**
 * Moves the plugin-era file to the current path, but only when nothing is at the current path
 * already - abandoning the legacy copy would blank the goal bar, which reads the same file.
 *
 * The path itself is resolved in core so the UI and the server cannot disagree about it; see
 * packages/core/src/goal/path.ts. Best-effort, as before: a failure here must not take goal
 * state down with it, so the legacy file stays put and a later run retries.
 */
function migrateLegacyStateFile() {
  // `legacyStateFile` documents that an explicit override means "the legacy default is not a
  // candidate", and that contract has to be enforced HERE, where the decision is made - not inferred
  // from the two paths happening to differ, which an override guarantees they do. It is a rename,
  // not a copy, so ignoring it did irreversible damage: pointing `OPENCODE_GOAL_STATE_PATH` at a
  // path that did not exist yet (the ordinary way to isolate goal state) moved a real user's
  // plugin-era goal file out of its home and into that path, and unsetting the override afterwards
  // left the goal stranded wherever the override pointed.
  if (process.env.OPENCODE_GOAL_STATE_PATH) return Effect.void
  const legacy = legacyStateFile()
  if (legacy === statePath()) return Effect.void
  return Effect.promise(async () => {
    if (existsSync(statePath())) return
    if (!existsSync(legacy)) return
    mkdirSync(dirname(statePath()), { recursive: true })
    renameSync(legacy, statePath())
  }).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.orDie,
  )
}

export { statePath }

function emptyState(): State {
  return { version: 1, goals: {} }
}

function isMissingStateFile(error: unknown) {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT"
}

/**
 * Moves an unreadable state file aside so goal state can recover instead of failing forever.
 * A corrupt/partial file must never permanently disable goals for every session: without this,
 * the only recovery is manually deleting the file by hand.
 */
function quarantineStateFile(reason: string) {
  const file = statePath()
  const stamp = Date.now()
  const target = `${file}.corrupt-${stamp}`
  rename(file, target).then(
    () => {
      console.warn(`[goal] state file was unreadable (${reason}); moved to ${target} and started from empty state`)
    },
    () => {
      console.warn(`[goal] state file was unreadable (${reason}) and could not be moved aside at ${target}`)
    },
  )
}

function mutableState(state: Schema.Schema.Type<typeof StateSchema>): State {
  return JSON.parse(JSON.stringify(state)) as State
}

function decodeState(value: unknown) {
  return Schema.decodeUnknownEffect(StateSchema)(value).pipe(
    Effect.map(mutableState),
    Effect.map(normalizeState),
    Effect.mapError((cause) => new StateDecodeError({ cause })),
  )
}

/** The state exactly as it is on disk, plus that disk text so a no-op mutation can skip its write. */
function readStateWithRawEffect() {
  return Effect.gen(function* () {
    yield* migrateLegacyStateFile()
    const raw = yield* Effect.tryPromise({
      try: () => readFile(statePath(), "utf8"),
      catch: (cause) => new StateReadError({ cause }),
    })
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) => new StateDecodeError({ cause }),
    })
    const state = yield* decodeState(parsed)
    return { state, raw }
  }).pipe(
    // A missing file is simply "no goals yet".
    Effect.catchTag("StateReadError", (error) =>
      // `raw: null` - there is no usable on-disk text, so the next mutation must write.
      isMissingStateFile(error.cause) ? Effect.succeed({ state: emptyState(), raw: null }) : Effect.fail(error),
    ),
    // A corrupt or schema-violating file is recoverable: quarantine it and start clean rather
    // than disabling goal state for every session until someone deletes the file by hand.
    Effect.catchTag("StateDecodeError", (error) =>
      Effect.suspend(() => {
        quarantineStateFile("decode failed")
        // The file was renamed aside, so again there is no usable on-disk text to compare against.
        return Effect.succeed({ state: emptyState(), raw: null })
      }),
    ),
  )
}

function readStateEffect() {
  return readStateWithRawEffect().pipe(Effect.map((read) => read.state))
}

/** The one serialization of the state file, used by BOTH the writer and the no-op comparison. */
function serializeState(state: State) {
  return JSON.stringify(state, null, 2) + "\n"
}

function writeStateEffect(state: State) {
  return Effect.tryPromise({
    try: async () => {
      const file = statePath()
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, serializeState(state), { mode: 0o600 })
      await rename(tmp, file)
      await chmod(file, 0o600).catch(() => undefined)
    },
    catch: (cause) => new StateWriteError({ cause }),
  })
}

export async function readState(): Promise<State> {
  return Effect.runPromise(readStateEffect())
}

let mutationQueue: Promise<void> = Promise.resolve()

function enqueueMutation<T>(operation: () => Promise<T>) {
  const current = mutationQueue.then(operation, operation)
  mutationQueue = current.then(
    () => undefined,
    () => undefined,
  )
  return current
}

export async function mutate<T>(fn: (state: State) => T | Promise<T>) {
  return enqueueMutation(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { state, raw } = yield* readStateWithRawEffect()
        const result = yield* Effect.tryPromise({
          try: () => Promise.resolve(fn(state)),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })
        // Skip the write when the state is byte-identical to what is already on disk. Every assistant
        // message mutates the file two or three times over (`accountUsage`, then
        // `recordAssistantProgress`, then the scored progress call), and each write serialized the
        // WHOLE state - every goal the user has ever run, forever, since only an explicit `clear_goal`
        // ever removes one. At 1000 stored goals one read+decode+serialize+write cycle measured 217ms
        // here, and a no-op mutation paid all of it to write back identical bytes.
        //
        // Comparing the exact `writeStateEffect` serialization against the exact bytes read is what
        // keeps the other behaviours intact rather than being a short cut around them: a normalizing
        // repair of a legacy field, a migration, or a quarantine all differ from disk and so still
        // write.
        //
        // HONEST SCOPE: this is worth only 4-6% of that cycle (217ms -> 208ms at 1000 goals), NOT the
        // 35% a first reading suggests, because `JSON.stringify` of the whole state is the dominant
        // cost and the comparison has to serialize too - it saves the write/rename/chmod syscalls and
        // stops the file's mtime churning, not the serialization. The real cost is architectural: the
        // state is one global file that only an explicit `clear_goal` ever prunes, and BOTH this
        // server and the TUI goal bar (which re-reads the whole file on every `message.updated`) parse
        // all of it on the hot path. Fixing that means a retention policy or a per-project file, which
        // is an owner's decision, so this stays a mitigation.
        if (serializeState(state) !== raw) yield* writeStateEffect(state)
        return result
      }),
    ),
  )
}

export function validateObjective(objective: string) {
  const value = objective.trim()
  if (!value) throw new GoalError({ message: "goal objective must not be empty" })
  if (!withinCharacterLimit(value, GOAL_MAX_OBJECTIVE))
    throw new GoalError({ message: `goal objective must be at most ${GOAL_MAX_OBJECTIVE} characters` })
  return value
}

export function validateEvidence(evidence: string | null | undefined, label: string) {
  const value = evidence?.trim()
  if (!value) throw new GoalError({ message: `${label} must not be empty` })
  if (!withinCharacterLimit(value, GOAL_MAX_EVIDENCE))
    throw new GoalError({ message: `${label} must be at most ${GOAL_MAX_EVIDENCE} characters` })
  return value
}

function normalizeState(state: State): State {
  for (const goal of Object.values(state.goals)) normalizeGoal(goal)
  return state
}

function normalizeGoal(goal: Goal) {
  goal.history = (goal.history ?? []).slice(-GOAL_HISTORY_LIMIT)
  goal.checkpoints = (goal.checkpoints ?? []).slice(-GOAL_CHECKPOINT_LIMIT)
  goal.lastCheckpoint = goal.lastCheckpoint ?? goal.checkpoints.at(-1) ?? null
  goal.lastAssistantText = boundRetainedText(goal.lastAssistantText)
  goal.lastAssistantMessageID ??= ""
  goal.lastPromptAgent ??= null
  goal.awaitingContinuationProgress = goal.awaitingContinuationProgress === true
  goal.continuationBaselineMessageID ??= ""
  goal.continuationBaselineSummary ??= ""
  goal.noProgressTurns = nonNegativeInteger(goal.noProgressTurns, 0)
  goal.tokensUsed = nonNegativeInteger(goal.tokensUsed, 0)
  // Every field that participates in arithmetic MUST be normalized here. A missing field would
  // otherwise produce NaN (e.g. `undefined + 1`), which silently disables guards that compare it
  // and then serializes to `null` via JSON.stringify, failing decode for every session.
  goal.continuationFailures = nonNegativeInteger(goal.continuationFailures, 0)
  goal.autoTurns = nonNegativeInteger(goal.autoTurns, 0)
  goal.timeUsedSeconds = nonNegativeInteger(goal.timeUsedSeconds, 0)
  // The token cursor. `accountUsage` differences each observation against `lastSessionTokens` and
  // falls back to `sessionTokensAtCreation`, so a negative value inflates every charge and a
  // fractional one makes `tokensUsed` fractional - which the `tokensUsed` normalization above then
  // snaps to 0 on the next read, silently forgetting all recorded usage. Dropping an untrusted value
  // is what makes `accountUsage` re-anchor from the creation total. Unlike the wall clocks below,
  // this one DROPS a fraction instead of flooring it: sub-second precision on a clock is real, but
  // sub-token precision on a token count is not, and re-anchoring is the safe direction for usage.
  // It must be `undefined` and not `null`: the schema declares these as `Schema.optional(Schema
  // .Number)`, which does not accept null, so writing null would fail decode and quarantine the
  // whole state file.
  goal.sessionTokensAtCreation = nonNegativeIntegerOrUndefined(goal.sessionTokensAtCreation)
  goal.lastSessionTokens = nonNegativeIntegerOrUndefined(goal.lastSessionTokens)
  // The wall-clock cursor, and the duration limit's counterpart to the token cursor.
  // `accountWallClock` adds `now - lastAccountedAt` to `timeUsedSeconds` and `snapshot` projects
  // the live delta from it. A negative value sits in the epoch, so it charged the whole epoch as
  // elapsed time and made the goal instantly unresumable against any duration limit; a fractional
  // one accrues a fraction that the `timeUsedSeconds` normalization above then snaps to 0, so the
  // elapsed time is forgotten and the limit can never trip. See `wallClockCursor`.
  goal.lastAccountedAt = wallClockCursor(goal.lastAccountedAt)
  // The continuation throttle cursor. See `reserveContinuation`: a cursor ahead of `now` is not a
  // throttle at all, and normalizing keeps this the last arithmetic field covered by the invariant.
  goal.lastContinuationAt = wallClockCursor(goal.lastContinuationAt)
  goal.createdAt = nonNegativeInteger(goal.createdAt, 0)
  goal.updatedAt = nonNegativeInteger(goal.updatedAt, 0)
  goal.maxAutoTurns = positiveIntegerOrNull(goal.maxAutoTurns)
  goal.maxDurationSeconds = positiveIntegerOrNull(goal.maxDurationSeconds)
  goal.tokenBudget = positiveIntegerOrNull(goal.tokenBudget)
  goal.noProgressTokenThreshold = positiveIntegerOrNull(goal.noProgressTokenThreshold) ?? GOAL_DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD
  goal.maxNoProgressTurns = positiveIntegerOrNull(goal.maxNoProgressTurns) ?? GOAL_DEFAULT_MAX_NO_PROGRESS_TURNS
  // Stays null unless the goal asked for a different tolerance; the plugin option is the
  // fallback applied at the call site, so null must survive normalization rather than
  // collapsing to the default here.
  goal.maxPromptFailures = positiveIntegerOrNull(goal.maxPromptFailures)
  goal.budgetWrapupSent = goal.budgetWrapupSent === true
  goal.stopReason ??= null
  return goal
}

function nonNegativeInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function nonNegativeIntegerOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * A fractional wall-clock cursor is only sub-second precision, so it is floored and the elapsed
 * time it represents is kept. A negative or non-finite one is untrustworthy and is dropped, which
 * re-anchors the cursor to now rather than charging time that never elapsed.
 */
function wallClockCursor(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null
  return Math.floor(value)
}

/**
 * Keeps the message PREFIX, so every summary derived from it is unchanged. Cutting on a code-point
 * boundary is what makes that true: a unit-boundary cut can split a surrogate pair, and the resulting
 * lone surrogate renders as a replacement character and makes the derived summary differ from the
 * one computed over the full text - which is the comparison stall detection reads.
 */
function boundRetainedText(value: unknown) {
  if (typeof value !== "string") return ""
  return truncateToCodePoints(value, GOAL_MAX_RETAINED_TEXT)
}

function isClosed(status: Goal["status"]) {
  return status === "complete" || status === "unmet"
}

/**
 * Resolves the auto-continue cap actually enforced for a goal. A goal-level `maxAutoTurns` wins;
 * otherwise the caller's configured default applies. 0 (or less) means unbounded, which is what
 * "omit or pass null for unlimited" resolves to.
 */
function effectiveAutoTurnLimit(goal: Goal, defaultMaxAutoTurns: number) {
  return goal.maxAutoTurns ?? defaultMaxAutoTurns ?? GOAL_DEFAULT_MAX_AUTO_TURNS
}

/**
 * True when the goal has not yet consumed its auto-continue allowance under the SAME limit that
 * runtime enforcement uses. Extension reactivation must never disagree with enforcement here.
 */
function hasAutoTurnHeadroom(goal: Goal, defaultMaxAutoTurns: number) {
  const limit = effectiveAutoTurnLimit(goal, defaultMaxAutoTurns)
  return limit <= 0 || goal.autoTurns < limit
}

function canContinue(status: Goal["status"]) {
  return status === "active"
}

/**
 * Shared reactivation bookkeeping. Every path that moves a goal back to `active` must reset the
 * failure and no-progress counters, otherwise a goal resumed via one path behaves differently
 * from the same goal resumed via another.
 */
function reactivate(goal: Goal) {
  goal.continuationFailures = 0
  goal.noProgressTurns = 0
  goal.awaitingContinuationProgress = false
  goal.budgetWrapupSent = false
  // The observed assistant message predates the pause, so it is not a valid progress baseline for
  // the first turn after resuming. Clear it so the resumed turn is not judged against stale text.
  goal.continuationBaselineMessageID = ""
  goal.continuationBaselineSummary = ""
}

function remainingTokens(goal: Goal) {
  return goal.tokenBudget == null ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed)
}

export function snapshot(goal: Goal): GoalSnapshot {
  normalizeGoal(goal)
  const sampledAt = Math.floor(Date.now() / 1000)
  const activeSeconds =
    goal.status === "active" && goal.lastAccountedAt != null ? Math.max(0, sampledAt - goal.lastAccountedAt) : 0
  const timeUsedSeconds = goal.timeUsedSeconds + activeSeconds
  return {
    sessionID: goal.sessionID,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    completionEvidence: goal.completionEvidence ?? null,
    blocker: goal.blocker ?? null,
    closedAt: goal.closedAt ?? null,
    continuationFailures: goal.continuationFailures,
    lastStatus: goal.lastStatus,
    maxAutoTurns: goal.maxAutoTurns,
    maxDurationSeconds: goal.maxDurationSeconds,
    noProgressTokenThreshold: goal.noProgressTokenThreshold,
    maxNoProgressTurns: goal.maxNoProgressTurns,
    maxPromptFailures: goal.maxPromptFailures,
    noProgressTurns: goal.noProgressTurns,
    budgetWrapupSent: goal.budgetWrapupSent,
    stopReason: goal.stopReason,
    history: goal.history,
    checkpoints: goal.checkpoints,
    lastCheckpoint: goal.lastCheckpoint,
    lastAssistantText: goal.lastAssistantText,
    lastAssistantMessageID: goal.lastAssistantMessageID,
    lastPromptAgent: goal.lastPromptAgent,
    awaitingContinuationProgress: goal.awaitingContinuationProgress,
    continuationBaselineMessageID: goal.continuationBaselineMessageID,
    continuationBaselineSummary: goal.continuationBaselineSummary,
    autoTurns: goal.autoTurns,
    lastContinuationAt: goal.lastContinuationAt,
    remainingTokens: remainingTokens(goal),
    sampledAt,
  }
}

export async function getGoal(sessionID: string) {
  const state = await readState()
  const goal = state.goals[sessionID]
  return goal ? snapshot(goal) : null
}

export async function createGoal(
  sessionID: string,
  objective: string,
  options?: number | null | CreateGoalOptions,
) {
  const value = validateObjective(objective)
  const normalizedOptions = normalizeCreateOptions(options)
  return mutate((state) => {
    const existing = state.goals[sessionID]
    if (existing && !isClosed(existing.status)) {
      throw new GoalError({ message: "cannot create a new goal because this session already has a non-closed goal" })
    }
    const now = Math.floor(Date.now() / 1000)
    const paused = normalizedOptions.initialStatus === "paused"
    const goal: Goal = {
      sessionID,
      objective: value,
      status: normalizedOptions.initialStatus,
      tokenBudget: normalizedOptions.tokenBudget,
      tokensUsed: 0,
      sessionTokensAtCreation: normalizedOptions.sessionTokensAtCreation ?? undefined,
      lastSessionTokens: normalizedOptions.sessionTokensAtCreation ?? undefined,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
      completionEvidence: null,
      blocker: paused ? "Goal execution is paused while the session is in Plan mode. Switch to Build mode and resume the goal to continue." : null,
      closedAt: null,
      lastAccountedAt: paused ? null : now,
      autoTurns: 0,
      lastContinuationAt: null,
      continuationFailures: 0,
      lastStatus: paused ? "Goal recorded from Plan mode; execution paused until resumed from Build mode." : "Goal set.",
      maxAutoTurns: normalizedOptions.maxAutoTurns,
      maxDurationSeconds: normalizedOptions.maxDurationSeconds,
      noProgressTokenThreshold: normalizedOptions.noProgressTokenThreshold,
      maxNoProgressTurns: normalizedOptions.maxNoProgressTurns,
      maxPromptFailures: normalizedOptions.maxPromptFailures,
      noProgressTurns: 0,
      budgetWrapupSent: false,
      stopReason: paused ? "plan mode" : null,
      history: [],
      checkpoints: [],
      lastCheckpoint: null,
      lastAssistantText: "",
      lastAssistantMessageID: "",
      lastPromptAgent: normalizedOptions.agent,
      awaitingContinuationProgress: false,
      continuationBaselineMessageID: "",
      continuationBaselineSummary: "",
    }
    pushHistory(goal, "created", goalLimitSummary(goal))
    if (paused) pushHistory(goal, "paused", goal.lastStatus)
    state.goals[sessionID] = goal
    return snapshot(goal)
  })
}

export async function updateGoalObjective(
  sessionID: string,
  objective: string,
  status: "active" | "paused" = "active",
  options?: { agent?: string | null; planModePause?: boolean; defaultMaxAutoTurns?: number },
) {
  const value = validateObjective(objective)
  const agent = typeof options?.agent === "string" && options.agent.trim() ? options.agent.trim() : null
  const planModePause = options?.planModePause === true
  const defaultMaxAutoTurns = options?.defaultMaxAutoTurns ?? GOAL_DEFAULT_MAX_AUTO_TURNS
  // Editing the objective resumes the goal, so it must obey the same limit guard a plain resume
  // does. Without it this path reactivates a goal the budget/turn/duration re-check would refuse.
  return mutateStatus((state) => {
    const goal = state.goals[sessionID]
    if (!goal) throw new GoalError({ message: "cannot update goal because this session has no goal" })
    if (isClosed(goal.status)) throw new GoalError({ message: "cannot reopen a closed goal" })
    if (status === "active" && (goal.status === "budgetLimited" || goal.status === "usageLimited")) {
      throw new GoalError({ message: "goal is limited; explicitly extend its limits before resuming" })
    }
    accountWallClock(goal)
    if (status === "active" && !planModePause && exhaustGoalLimits(goal, defaultMaxAutoTurns)) {
      return { goal: snapshot(goal), limited: true }
    }
    goal.objective = value
    goal.status = planModePause ? "paused" : status
    goal.updatedAt = Math.floor(Date.now() / 1000)
    goal.lastAccountedAt = goal.status === "active" ? goal.updatedAt : null
    goal.completionEvidence = null
    goal.blocker = planModePause ? "Goal execution is paused while the session is in Plan mode. Switch to Build mode and resume the goal to continue." : null
    goal.closedAt = null
    goal.stopReason = planModePause ? "plan mode" : null
    if (goal.status === "active") reactivate(goal)
    if (agent) goal.lastPromptAgent = agent
    goal.lastStatus = planModePause
      ? "Goal objective updated; execution paused while the session is in Plan mode."
      : goal.status === "active"
        ? "Goal objective updated and resumed."
        : "Goal objective updated and paused."
    // `pushHistory` applies the ONE history limit (`GOAL_CHECKPOINT_CHAR_LIMIT`), so the objective
    // goes in raw. Summarizing to 400 first was a second, larger limit nested inside a smaller one:
    // the result could never exceed the 280 the outer call enforces, so the 400 did nothing except
    // imply that a history entry can hold 400 characters of objective when it can hold 280.
    pushHistory(goal, "updated", `Goal objective updated: ${value}`)
    if (planModePause) pushHistory(goal, "paused", goal.lastStatus)
    return { goal: snapshot(goal), limited: false }
  })
}

export async function recordPromptAgent(sessionID: string, agent: string) {
  const value = agent.trim()
  if (!value) return null
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal || isClosed(goal.status)) return goal ? snapshot(goal) : null
    if (goal.lastPromptAgent === value) return snapshot(goal)
    goal.lastPromptAgent = value
    goal.updatedAt = Math.floor(Date.now() / 1000)
    return snapshot(goal)
  })
}

export async function pauseGoalForPlanMode(sessionID: string) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal || goal.status !== "active") return goal ? snapshot(goal) : null
    accountWallClock(goal)
    goal.status = "paused"
    goal.lastAccountedAt = null
    goal.stopReason = "plan mode"
    goal.blocker = "Goal execution is paused while the session is in Plan mode. Switch to Build mode and resume the goal to continue."
    goal.lastStatus = "Auto-continue paused while the session is in Plan mode."
    goal.updatedAt = Math.floor(Date.now() / 1000)
    pushHistory(goal, "paused", goal.lastStatus)
    return snapshot(goal)
  })
}

export async function setGoalStatus(
  sessionID: string,
  status: "active" | "paused",
  agent?: string | null,
  // The caller's configured turn default, so the resume guard below resolves the SAME effective cap
  // that `reserveContinuation` enforces and `extendGoal` eligibility uses. All three disagreeing is
  // what made the turn cap the one limit a resume could walk past.
  defaultMaxAutoTurns: number = GOAL_DEFAULT_MAX_AUTO_TURNS,
) {
  const agentValue = typeof agent === "string" && agent.trim() ? agent.trim() : null
  return mutateStatus((state) => {
    const goal = state.goals[sessionID]
    if (!goal) throw new GoalError({ message: "cannot update goal because this session has no goal" })
    if (isClosed(goal.status)) throw new GoalError({ message: "cannot reopen a closed goal" })
    if (status === "active" && (goal.status === "budgetLimited" || goal.status === "usageLimited")) {
      throw new GoalError({ message: "goal is limited; explicitly extend its limits before resuming" })
    }
    // A repeated "/goal pause" must not churn history or restate a transition that did not happen.
    if (goal.status === status) return { goal: snapshot(goal), limited: false }
    accountWallClock(goal)
    if (status === "active" && exhaustGoalLimits(goal, defaultMaxAutoTurns))
      return { goal: snapshot(goal), limited: true }
    goal.status = status
    goal.updatedAt = Math.floor(Date.now() / 1000)
    goal.lastAccountedAt = status === "active" ? goal.updatedAt : null
    if (status === "active") reactivate(goal)
    goal.stopReason = status === "active" ? null : "paused"
    goal.blocker = status === "active" ? null : goal.blocker
    if (agentValue) goal.lastPromptAgent = agentValue
    goal.lastStatus = status === "active" ? "Goal resumed." : "Goal paused."
    pushHistory(goal, status === "active" ? "resumed" : "paused", goal.lastStatus)
    return { goal: snapshot(goal), limited: false }
  })
}

/**
 * Runs a status transition, committing the goal's limited status when a reactivation is refused.
 * `mutate` writes only after its callback returns, so raising the refusal from inside that callback
 * would discard the transition and leave a goal that can neither be resumed nor extended.
 */
async function mutateStatus<T>(run: (state: State) => { goal: T; limited: boolean }) {
  const result = await mutate(run)
  if (result.limited) throw new GoalError({ message: "goal is limited; explicitly extend its limits before resuming" })
  return result.goal
}

/**
 * Moves a goal into its limited status when it has already exhausted a limit, reporting whether it
 * did. Re-checked before every reactivation, not just the turn cap, so a goal that outgrew its
 * budget or duration while paused cannot be resumed and then corrected a turn later.
 *
 * `defaultMaxAutoTurns` MUST be the same value runtime enforcement and `extendGoal` eligibility use.
 * Hardcoding the unbounded default here is what made the turn cap the one limit a resume could walk
 * past: it reached this same `maybeStopForUsageLimit` call, but with a default that rendered its
 * turn-cap branch inert, so only the duration branch could ever trip.
 */
function exhaustGoalLimits(goal: Goal, defaultMaxAutoTurns: number) {
  if (goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget) return maybeStopForBudget(goal)
  // Covers the turn cap AND the duration: both are the same `usageLimited` status, and both are
  // enforced from the same effective limit, so one call resolves them consistently.
  if (goal.maxDurationSeconds != null && goal.timeUsedSeconds >= goal.maxDurationSeconds)
    return maybeStopForUsageLimit(goal, defaultMaxAutoTurns)
  if (!hasAutoTurnHeadroom(goal, defaultMaxAutoTurns)) return maybeStopForUsageLimit(goal, defaultMaxAutoTurns)
  return false
}

export async function extendGoal(
  sessionID: string,
  options: ExtendGoalOptions,
  defaultMaxAutoTurns: number = GOAL_DEFAULT_MAX_AUTO_TURNS,
) {
  const fields = [
    ["tokenBudget", options.tokenBudget],
    ["maxAutoTurns", options.maxAutoTurns],
    ["maxDurationSeconds", options.maxDurationSeconds],
  ] as const
  if (!fields.some(([, value]) => value !== undefined)) {
    throw new GoalError({ message: "goal extension must explicitly change at least one limit" })
  }
  for (const [name, value] of fields) {
    if (value === undefined || value === null) continue
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new GoalError({ message: `${name} must be a positive integer or null` })
    }
  }
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal) throw new GoalError({ message: "cannot extend goal because this session has no goal" })
    if (isClosed(goal.status)) throw new GoalError({ message: "cannot extend a closed goal" })
    if (goal.status !== "budgetLimited" && goal.status !== "usageLimited") {
      throw new GoalError({ message: "only a limited goal can be explicitly extended" })
    }
    accountWallClock(goal)
    const changes: string[] = []
    for (const [name, value] of fields) {
      if (value === undefined) continue
      if (value !== null) {
        const current = goal[name]
        if (current !== null && value <= current) {
          throw new GoalError({ message: `${name} extension must be higher than the current limit (${current})` })
        }
      }
      goal[name] = value
      changes.push(`${name}=${value === null ? "default/no limit" : value}`)
    }
    const now = Math.floor(Date.now() / 1000)
    const eligible =
      (goal.tokenBudget == null || goal.tokensUsed < goal.tokenBudget) &&
      (goal.maxDurationSeconds == null || goal.timeUsedSeconds < goal.maxDurationSeconds) &&
      hasAutoTurnHeadroom(goal, defaultMaxAutoTurns)
    if (eligible) {
      goal.status = "active"
      goal.lastAccountedAt = now
      goal.stopReason = null
      goal.blocker = null
      reactivate(goal)
      goal.lastContinuationAt = null
      goal.continuationBaselineMessageID = ""
      goal.continuationBaselineSummary = ""
      goal.lastStatus = "Goal limits extended; execution reactivated."
    } else {
      goal.lastStatus = "Goal limits extended, but cumulative usage still exceeds a limit."
    }
    goal.updatedAt = now
    pushHistory(goal, "extended", `Goal limits extended (${changes.join(", ")}); ${goal.lastStatus}`)
    return snapshot(goal)
  })
}

export async function closeGoal(
  sessionID: string,
  input:
    | { status: "complete"; evidence: string }
    | { status: "unmet"; blocker: string },
) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal) throw new GoalError({ message: "cannot update goal because this session has no goal" })
    if (isClosed(goal.status)) throw new GoalError({ message: "cannot close a goal that is already closed" })
    accountWallClock(goal)
    const now = Math.floor(Date.now() / 1000)
    goal.status = input.status
    goal.updatedAt = now
    goal.closedAt = now
    goal.lastAccountedAt = null
    goal.stopReason = input.status === "complete" ? null : "blocked"
    if (input.status === "complete") {
      goal.completionEvidence = validateEvidence(input.evidence, "completion evidence")
      goal.blocker = null
      goal.lastStatus = "Goal completed."
      pushHistory(goal, "completed", goal.completionEvidence)
    } else {
      goal.blocker = validateEvidence(input.blocker, "blocker")
      goal.completionEvidence = null
      goal.lastStatus = "Goal marked unmet."
      pushHistory(goal, "unmet", goal.blocker)
    }
    return snapshot(goal)
  })
}

export async function completeGoal(sessionID: string, evidence: string) {
  return closeGoal(sessionID, { status: "complete", evidence })
}

export async function markGoalUnmet(sessionID: string, blocker: string) {
  return closeGoal(sessionID, { status: "unmet", blocker })
}

export async function clearGoal(sessionID: string) {
  return mutate((state) => {
    const existed = Boolean(state.goals[sessionID])
    delete state.goals[sessionID]
    return existed
  })
}

export async function accountUsage(sessionID: string, tokensUsed?: number) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    // Closed goals are immutable: a completion audit must report stable, reproducible numbers.
    if (!goal || isClosed(goal.status)) return goal ? snapshot(goal) : null
    accountWallClock(goal)
    if (typeof tokensUsed === "number" && Number.isFinite(tokensUsed)) {
      const cumulative = Math.max(0, Math.ceil(tokensUsed))
      if (goal.lastSessionTokens != null) {
        // Session totals can fall after compaction. Keep goal usage monotonic and charge only
        // positive growth since the latest observed total.
        goal.tokensUsed += Math.max(0, cumulative - goal.lastSessionTokens)
        goal.lastSessionTokens = cumulative
      } else if (goal.sessionTokensAtCreation == null) {
        // If creation-time usage was unavailable, anchor a new zero-usage goal now. For a legacy
        // goal, preserve its already-accounted usage while establishing the same cursor.
        goal.sessionTokensAtCreation = cumulative
        goal.lastSessionTokens = cumulative
        if (goal.tokensUsed !== 0) goal.tokensUsed = Math.max(goal.tokensUsed, cumulative)
      } else {
        // The creation total was persisted but the observation cursor was not.
        goal.tokensUsed += Math.max(0, cumulative - goal.sessionTokensAtCreation)
        goal.lastSessionTokens = cumulative
      }
    }
    maybeStopForBudget(goal)
    goal.updatedAt = Math.floor(Date.now() / 1000)
    return snapshot(goal)
  })
}

export async function recordAssistantProgress(sessionID: string, input: AssistantProgressInput) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal || goal.status !== "active") return goal ? snapshot(goal) : null

    const text = input.text?.trim() ?? ""
    const messageID = input.messageID?.trim() ?? ""
    const outputTokens = positiveIntegerOrNull(input.outputTokens) ?? 0
    // The GOAL's own tolerance, always - it is resolved the same way `maxPromptFailures` is, and it
    // must be. These two limits exist twice, as a plugin option and as a per-goal tool argument, and
    // the tool documents the per-goal value as the one that wins: "a caller that asks for a tolerant
    // goal must not be silently downgraded". Taking an override here instead put the OPTION ahead of
    // the goal on every scored turn, so a goal created with `max_no_progress_turns: 8` for an
    // overnight run self-paused after the option's 2 while `get_goal` reported 8 - the reported limit
    // and the enforced one disagreeing, which is what the per-goal argument exists to prevent. The
    // option still applies: `createGoal` folds it in as the default for any goal that did not ask.
    const threshold = goal.noProgressTokenThreshold ?? GOAL_DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD
    const maxNoProgressTurns = goal.maxNoProgressTurns
    const summary = summarizeText(text)
    const previousSummary = summarizeText(goal.lastAssistantText)
    const repeatedMessage = Boolean(messageID && messageID === goal.lastAssistantMessageID)
    const changed = Boolean(summary && summary !== previousSummary)

    if (summary && (!repeatedMessage || changed)) recordCheckpoint(goal, summary)
    if (text) goal.lastAssistantText = boundRetainedText(text)
    if (messageID) goal.lastAssistantMessageID = messageID

    const continuationTurnCompleted =
      input.evaluateContinuation === true &&
      goal.awaitingContinuationProgress &&
      Boolean(messageID) &&
      messageID !== goal.continuationBaselineMessageID
    if (continuationTurnCompleted) {
      goal.awaitingContinuationProgress = false
      // A turn that produced no output at all is the most degenerate no-progress case, so it must
      // NOT be scored as progress. Previously `outputTokens > 0 &&` made a zero-token turn reset
      // the counter, silently disabling stall detection for providers that report no step tokens.
      const lowOutput = outputTokens < threshold
      const changedSinceContinuation = Boolean(summary && summary !== goal.continuationBaselineSummary)
      // A turn that ran tools did something, even when the model narrated none of it. Scoring
      // on prose alone paused a long refactor or investigation - the common unattended shape -
      // after two tool-only turns, calling real work a stall.
      const workedWithTools = (input.toolCalls ?? 0) > 0
      if (lowOutput && !changedSinceContinuation && !workedWithTools) {
        goal.noProgressTurns += 1
        if (maxNoProgressTurns && goal.noProgressTurns >= maxNoProgressTurns) {
          accountWallClock(goal)
          goal.status = "paused"
          goal.lastAccountedAt = null
          goal.stopReason = "no progress"
          goal.blocker = `Auto-continue paused after ${goal.noProgressTurns} low-progress continuation turn(s). Resume the goal to retry.`
          goal.lastStatus = goal.blocker
          pushHistory(goal, "warning", goal.blocker)
        } else {
          goal.lastStatus = `Low-progress continuation turn detected (${goal.noProgressTurns}/${maxNoProgressTurns ?? "unbounded"}).`
          pushHistory(goal, "warning", goal.lastStatus)
        }
      } else {
        goal.noProgressTurns = 0
      }
    }

    goal.updatedAt = Math.floor(Date.now() / 1000)
    return snapshot(goal)
  })
}

export async function reserveContinuation(sessionID: string, maxAutoTurns: number, minIntervalSeconds: number) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal) return null
    if (goal.status === "budgetLimited" || goal.status === "usageLimited") return reserveWrapup(goal)
    if (!canContinue(goal.status)) return null
    const now = Math.floor(Date.now() / 1000)
    accountWallClock(goal, now)
    if (maybeStopForUsageLimit(goal, maxAutoTurns, now)) return reserveWrapup(goal)
    // Only a cursor that is actually in the past can throttle. A cursor ahead of `now` yields a
    // negative delta, which is below any interval, so the goal is throttled until the wall clock
    // catches up - silently, and `reactivate` does not clear it either, so a resume does not help.
    // A backwards clock step (NTP correction, VM resume) is enough to leave it there.
    if (goal.lastContinuationAt && goal.lastContinuationAt <= now && now - goal.lastContinuationAt < minIntervalSeconds)
      return null
    goal.autoTurns += 1
    goal.lastContinuationAt = now
    goal.continuationBaselineMessageID = goal.lastAssistantMessageID
    goal.continuationBaselineSummary = summarizeText(goal.lastAssistantText)
    goal.lastStatus = `Auto-continue ${goal.autoTurns} reserved.`
    pushHistory(goal, "autoContinue", goal.lastStatus)
    goal.updatedAt = now
    return snapshot(goal)
  })
}

export async function recordContinuationResult(sessionID: string, result: "success" | "failure", maxFailures: number) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal || isClosed(goal.status)) return goal ? snapshot(goal) : null
    const now = Math.floor(Date.now() / 1000)
    goal.updatedAt = now
    if (result === "success") {
      goal.continuationFailures = 0
      if (goal.status === "active") {
        goal.lastStatus = "Auto-continue prompt sent."
        goal.awaitingContinuationProgress = true
      }
      return snapshot(goal)
    }
    goal.continuationFailures += 1
    goal.awaitingContinuationProgress = false
    goal.lastStatus = `Auto-continue failed ${goal.continuationFailures} time(s).`
    pushHistory(goal, "error", goal.lastStatus)
    // A goal-level tolerance wins over the plugin-wide default so an unattended run can ride out
    // transient provider failures; without it three blips pause the goal while nobody is watching.
    const effectiveMaxFailures = goal.maxPromptFailures ?? maxFailures
    // Only an ACTIVE goal may be auto-paused here. A limited goal must keep its limited status and
    // its stopReason: rewriting it to `paused` would bypass the "extend before resuming" guard,
    // because setGoalStatus only rejects budgetLimited/usageLimited.
    if (goal.continuationFailures >= effectiveMaxFailures && goal.status === "active") {
      accountWallClock(goal, now)
      goal.status = "paused"
      goal.lastAccountedAt = null
      goal.stopReason = "auto-continue failures"
      goal.lastStatus = `Paused after ${goal.continuationFailures} auto-continue failure(s).`
      goal.blocker = "Auto-continue prompt failed repeatedly. Resume the goal to retry."
      pushHistory(goal, "paused", goal.lastStatus)
    }
    return snapshot(goal)
  })
}

function reserveWrapup(goal: Goal) {
  if (goal.budgetWrapupSent) return null
  goal.budgetWrapupSent = true
  goal.updatedAt = Math.floor(Date.now() / 1000)
  pushHistory(goal, "limited", `${goal.status}: ${goal.stopReason ?? "goal limit reached"}; requested final handoff.`)
  return snapshot(goal)
}

function maybeStopForBudget(goal: Goal) {
  // A goal that outgrew its budget is over it whether or not it was paused. Leaving it `paused`
  // reports a resume-able goal that `setGoalStatus` then refuses to resume, and `extendGoal` in
  // turn refuses to extend, so the goal is wedged with no remedy short of clearing it. The
  // already-limited statuses are skipped so accounting every step cannot restate the transition,
  // and a CLOSED goal is skipped so this can never overwrite `complete`/`unmet` - the callers all
  // filter closed goals out today, and the guard is what keeps that true if a caller ever does not.
  if (isClosed(goal.status) || goal.status === "budgetLimited" || goal.status === "usageLimited") return false
  if (goal.tokenBudget == null || goal.tokensUsed < goal.tokenBudget) return false
  accountWallClock(goal)
  goal.status = "budgetLimited"
  goal.lastAccountedAt = null
  goal.stopReason = `token budget reached (${goal.tokensUsed}/${goal.tokenBudget})`
  goal.lastStatus = `${goal.stopReason}; wrap-up required.`
  pushHistory(goal, "limited", goal.lastStatus)
  return true
}

function maybeStopForUsageLimit(goal: Goal, defaultMaxAutoTurns: number, now = Math.floor(Date.now() / 1000)) {
  // Same reasoning as maybeStopForBudget: a paused goal can also have exhausted its turn or
  // duration allowance, and reporting that as a limit is what keeps it extendable. A closed goal is
  // excluded for the same reason - neither guard may overwrite `complete`/`unmet`.
  if (isClosed(goal.status) || goal.status === "budgetLimited" || goal.status === "usageLimited") return false
  const effectiveMaxAutoTurns = effectiveAutoTurnLimit(goal, defaultMaxAutoTurns)
  if (effectiveMaxAutoTurns > 0 && goal.autoTurns >= effectiveMaxAutoTurns) {
    goal.status = "usageLimited"
    goal.lastAccountedAt = null
    goal.stopReason = `max auto-continues reached (${effectiveMaxAutoTurns})`
    goal.lastStatus = `${goal.stopReason}; wrap-up required.`
    pushHistory(goal, "limited", goal.lastStatus)
    goal.updatedAt = now
    return true
  }
  if (goal.maxDurationSeconds != null && goal.timeUsedSeconds >= goal.maxDurationSeconds) {
    goal.status = "usageLimited"
    goal.lastAccountedAt = null
    goal.stopReason = `max duration reached (${goal.maxDurationSeconds}s)`
    goal.lastStatus = `${goal.stopReason}; wrap-up required.`
    pushHistory(goal, "limited", goal.lastStatus)
    goal.updatedAt = now
    return true
  }
  return false
}

function accountWallClock(goal: Goal, now = Math.floor(Date.now() / 1000)) {
  if (goal.status !== "active") return
  if (goal.lastAccountedAt == null) {
    goal.lastAccountedAt = now
    return
  }
  goal.timeUsedSeconds += Math.max(0, now - goal.lastAccountedAt)
  goal.lastAccountedAt = now
}

function recordCheckpoint(goal: Goal, summary: string) {
  const checkpoint = { summary: summarizeText(summary), timestamp: Math.floor(Date.now() / 1000) }
  if (!checkpoint.summary) return
  // Dedupe against the whole retained window, not just the latest checkpoint, so an A→B→A
  // oscillation does not spend the checkpoint and history budgets on a repeat.
  if (goal.checkpoints.some((existing) => existing.summary === checkpoint.summary)) return
  goal.lastCheckpoint = checkpoint
  goal.checkpoints = [...goal.checkpoints, checkpoint].slice(-GOAL_CHECKPOINT_LIMIT)
  pushHistory(goal, "checkpoint", checkpoint.summary)
}

function pushHistory(goal: Goal, type: GoalHistoryType, detail: string | null | undefined) {
  const value = summarizeText(detail ?? "", GOAL_CHECKPOINT_CHAR_LIMIT)
  if (!value) return
  goal.history = [...goal.history, { type, detail: value, timestamp: Math.floor(Date.now() / 1000) }].slice(-GOAL_HISTORY_LIMIT)
}

function summarizeText(text: string, limit = GOAL_CHECKPOINT_CHAR_LIMIT) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  // The limit is a CHARACTER limit, so it is counted and cut in the same unit the model reads it
  // in, matching `withinCharacterLimit`. A unit-based cut can end the summary on a lone surrogate,
  // and every summary is compared against another summary to decide whether a turn did anything.
  const shortened = truncateToCodePoints(normalized, limit)
  return shortened.length === normalized.length ? shortened : `${truncateToCodePoints(normalized, limit - 1)}...`
}

function goalLimitSummary(goal: Goal) {
  const limits = [
    goal.tokenBudget == null ? null : `${goal.tokenBudget} token budget`,
    goal.maxAutoTurns == null ? null : `${goal.maxAutoTurns} auto-continue limit`,
    goal.maxDurationSeconds == null ? null : `${goal.maxDurationSeconds}s duration limit`,
  ].filter(Boolean)
  return limits.length ? `Goal set with ${limits.join(", ")}.` : "Goal set with no limits (unlimited tokens, turns, and duration)."
}

/**
 * Escapes untrusted text before it is interpolated into a prompt. Model-authored fields
 * (objective, blocker, evidence, lastStatus, stopReason) all reach prompt templates, so escaping
 * must be applied consistently rather than on only one of the paths that embed them.
 */
export function escapePromptText(input: string) {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export function formatGoal(goal: GoalSnapshot | null) {
  if (!goal) return "No goal is set for this session."
  const safe = escapePromptText
  const lines = [
    `Objective: ${safe(goal.objective)}`,
    `Status: ${goal.status}`,
    `Time used: ${goal.timeUsedSeconds}s`,
    `Tokens used: ${goal.tokensUsed}${goal.tokenBudget == null ? "" : `/${goal.tokenBudget}`}`,
    `Auto-continues: ${goal.autoTurns}${goal.maxAutoTurns == null ? "" : `/${goal.maxAutoTurns}`}`,
  ]
  if (goal.remainingTokens != null) lines.push(`Tokens remaining: ${goal.remainingTokens}`)
  if (goal.maxDurationSeconds != null) lines.push(`Duration limit: ${goal.maxDurationSeconds}s`)
  if (goal.noProgressTurns > 0) lines.push(`No-progress turns: ${goal.noProgressTurns}`)
  if (goal.lastCheckpoint) lines.push(`Latest checkpoint: ${safe(goal.lastCheckpoint.summary)}`)
  if (goal.lastStatus) lines.push(`Last status: ${safe(goal.lastStatus)}`)
  if (goal.stopReason) lines.push(`Stop reason: ${safe(goal.stopReason)}`)
  if (goal.completionEvidence) lines.push(`Completion evidence: ${safe(goal.completionEvidence)}`)
  if (goal.blocker) lines.push(`Blocker: ${safe(goal.blocker)}`)
  return lines.join("\n")
}

export function formatGoalHistory(goal: GoalSnapshot | null) {
  if (!goal) return "No goal history is available for this session."
  if (goal.history.length === 0) return "No goal history recorded yet."
  // `entry.detail` quotes the objective, completion evidence, blocker and assistant prose, so it is
  // model- and user-authored and reaches the model through `get_goal_history`. It needs the same
  // escaping `formatGoal` applies, or a report that quotes a closing `</untrusted_objective>` breaks
  // straight out of the wrapper the continuation prompt puts the objective in.
  return goal.history.map((entry) => historyLine(entry)).join("\n")
}

function historyLine(entry: Goal["history"][number]) {
  return `- [${new Date(entry.timestamp * 1000).toISOString()}] ${entry.type}: ${escapePromptText(entry.detail)}`
}

function normalizeCreateOptions(input?: number | null | CreateGoalOptions): Required<CreateGoalOptions> {
  if (typeof input === "number" || input === null) {
    return {
      tokenBudget: positiveIntegerOrNull(input),
      maxAutoTurns: null,
      maxDurationSeconds: null,
      noProgressTokenThreshold: GOAL_DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD,
      maxNoProgressTurns: GOAL_DEFAULT_MAX_NO_PROGRESS_TURNS,
      maxPromptFailures: null,
      agent: null,
      initialStatus: "active",
      sessionTokensAtCreation: null,
    }
  }
  return {
    tokenBudget: positiveIntegerOrNull(input?.tokenBudget),
    maxAutoTurns: positiveIntegerOrNull(input?.maxAutoTurns),
    maxDurationSeconds: positiveIntegerOrNull(input?.maxDurationSeconds),
    noProgressTokenThreshold: positiveIntegerOrNull(input?.noProgressTokenThreshold) ?? GOAL_DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD,
    maxNoProgressTurns: positiveIntegerOrNull(input?.maxNoProgressTurns) ?? GOAL_DEFAULT_MAX_NO_PROGRESS_TURNS,
    maxPromptFailures: positiveIntegerOrNull(input?.maxPromptFailures),
    agent: typeof input?.agent === "string" && input.agent.trim() ? input.agent.trim() : null,
    initialStatus: input?.initialStatus === "paused" ? "paused" : "active",
    sessionTokensAtCreation:
      typeof input?.sessionTokensAtCreation === "number" && Number.isSafeInteger(input.sessionTokensAtCreation)
        ? Math.max(0, input.sessionTokensAtCreation)
        : null,
  }
}
