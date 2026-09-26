import { Data, Schema } from "effect"

export const GOAL_SYSTEM_MARKER = "OpenCode goal mode"
export const GOAL_METADATA_KEY = "opencode.goal"

/**
 * Character limits count Unicode CODE POINTS, not UTF-16 code units, because a code unit is not a
 * character: `z.string().max(n)` counts units, so an objective of n emoji is rejected by the tool
 * boundary while `validateObjective` - which counts code points, the reading the message states -
 * accepts it. The two therefore disagreed on exactly the input people least expect to be
 * re-counted, and the tool boundary won, so the model got a schema error instead of the far clearer
 * "goal objective must be at most N characters".
 *
 * These constants are the ONLY definition of each limit. The tool schemas and the implementation
 * must both resolve through them; when they were separate literals the two had already drifted.
 */
export const GOAL_MAX_OBJECTIVE = 4000
export const GOAL_MAX_EVIDENCE = 4000
/**
 * The ONE definition of "is this model-supplied string within its character limit?", shared by the
 * zod tool schemas and by `validateObjective`/`validateEvidence`. Counting lives here rather than
 * in each caller because the two previously used different units, which is precisely how a limit
 * ends up meaning two different things.
 */
export function withinCharacterLimit(value: string, maxCodePoints: number) {
  return codePoints(value).length <= maxCodePoints
}

/**
 * The one truncation, in the same unit as `withinCharacterLimit`.
 *
 * Every truncation in the goal module has to cut on a code-point boundary and count in code points.
 * `String.prototype.slice` counts UTF-16 code units, so cutting a string of emoji or any other
 * astral character at a unit boundary can land in the middle of a surrogate pair and leave a LONE
 * SURROGATE behind. That is not a cosmetic artifact: a lone surrogate serializes to `\udXXX`, is
 * read back as a replacement character by anything that renders it, and - because
 * `lastAssistantText` is what every progress summary and continuation baseline is derived from - it
 * makes a summary differ from the same summary computed over the untruncated text, which is the
 * comparison stall detection turns on.
 */
export function truncateToCodePoints(value: string, maxCodePoints: number) {
  if (withinCharacterLimit(value, maxCodePoints)) return value
  return codePoints(value).slice(0, maxCodePoints).join("")
}

function codePoints(value: string) {
  return [...value]
}

/**
 * Upper bound on the assistant text a goal retains for its own bookkeeping. Every use of it goes
 * through a 280-character summary, so nothing is lost by capping it: without a cap, one verbose turn
 * is stored verbatim and then re-serialized by every subsequent LLM step (each `accountUsage` rewrites
 * the state file) and echoed in full by `get_goal` into the model's context.
 */
export const GOAL_MAX_RETAINED_TEXT = 4000
export const GOAL_HISTORY_LIMIT = 50
export const GOAL_CHECKPOINT_LIMIT = 8
export const GOAL_CHECKPOINT_CHAR_LIMIT = 280
/**
 * The completed-work ledger is the goal's only durable record of what it has already finished.
 * Checkpoints are a capped, deduplicated prose window of 8 entries, which cannot answer "have I
 * already done this?" for an objective that spans many turns. Without it a long-running goal
 * re-derived its own history from the repo, re-found the same defects, and re-fixed them.
 */
export const GOAL_MAX_COMPLETED_ITEMS = 40
export const GOAL_MAX_COMPLETED_ITEM_CHARS = 200
/**
 * A continuation turn is scored as low-progress only when it emits fewer than this many output
 * tokens AND its text is unchanged from the previous continuation baseline. The text check is the
 * real stall signal; this is a floor that keeps a near-empty turn from being read as progress.
 *
 * The previous value of 50 was low enough to punish a terse but busy turn: an overnight agent that
 * runs one command and reports in a sentence emits well under 50 output tokens, so it was paused
 * for being efficient. 500 leaves room for short tool-driven turns while still catching a turn
 * that genuinely produced almost nothing.
 */
export const GOAL_DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD = 500
export const GOAL_DEFAULT_MAX_NO_PROGRESS_TURNS = 2
/**
 * Effective auto-continue cap applied when a goal does not carry its own `maxAutoTurns`.
 * 0 means unbounded, matching the documented "omit or pass null for unlimited" tool contract.
 * This is the single source of truth: `extendGoal` reactivation eligibility and the runtime
 * enforcement in `maybeStopForUsageLimit` MUST both resolve through it.
 */
export const GOAL_DEFAULT_MAX_AUTO_TURNS = 0
export const GOAL_DEFAULT_CONTINUE_INTERVAL_SECONDS = 3
export const GOAL_DEFAULT_MAX_PROMPT_FAILURES = 3

/**
 * The one definition of "is this a usable positive-integer limit?". Both the state normalizer and
 * the tool/option layer validate limits with it, and they must agree: a value one accepts and the
 * other rejects silently changes a limit between creation and the next read. It used to be
 * duplicated verbatim in `impl.ts` and `shared.ts`, which is how the two drifted apart before.
 */
export function positiveIntegerOrNull(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

export type GoalStatus = "active" | "paused" | "budgetLimited" | "usageLimited" | "complete" | "unmet"
export type MutableGoalStatus = "active" | "paused"
export type GoalHistoryType =
  | "created"
  | "updated"
  | "extended"
  | "paused"
  | "resumed"
  | "completed"
  | "unmet"
  | "autoContinue"
  | "checkpoint"
  | "progress"
  | "warning"
  | "limited"
  | "error"

export type GoalHistoryEntry = {
  type: GoalHistoryType
  detail: string
  timestamp: number
}

export type GoalCheckpoint = {
  summary: string
  timestamp: number
}

export type Goal = {
  sessionID: string
  objective: string
  status: GoalStatus
  tokenBudget: number | null
  tokensUsed: number
  /** Cumulative session token total when the goal was created. */
  sessionTokensAtCreation?: number
  /** Most recent cumulative session token total used to calculate goal-local deltas. */
  lastSessionTokens?: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
  completionEvidence: string | null
  blocker: string | null
  closedAt: number | null
  lastAccountedAt: number | null
  autoTurns: number
  lastContinuationAt: number | null
  continuationFailures: number
  lastStatus: string | null
  maxAutoTurns: number | null
  maxDurationSeconds: number | null
  noProgressTokenThreshold: number | null
  maxNoProgressTurns: number | null
  /**
   * Per-goal cap on consecutive failed auto-continue prompts. Kept on the goal so a long
   * unattended run can tolerate transient provider/network failures instead of self-pausing
   * after the plugin-wide default. `null` means "use the plugin option".
   */
  maxPromptFailures: number | null
  noProgressTurns: number
  budgetWrapupSent: boolean
  stopReason: string | null
  history: GoalHistoryEntry[]
  checkpoints: GoalCheckpoint[]
  /**
   * Items the agent has finished, oldest first. Written by `record_goal_completion` and read back
   * into the continuation prompt, so a turn starts from what is LEFT rather than re-deriving the
   * whole objective. This is the record that lets a goal move on instead of looping.
   */
  completed: string[]
  lastCheckpoint: GoalCheckpoint | null
  lastAssistantText: string
  lastAssistantMessageID: string
  lastPromptAgent: string | null
  awaitingContinuationProgress: boolean
  continuationBaselineMessageID: string
  continuationBaselineSummary: string
  /**
   * Ledger length when the current continuation turn was reserved. Progress scoring compares it
   * against the length at the end of the turn: a tool-heavy turn that closed nothing out is the
   * signature of a loop, and without this the counter could never see one.
   */
  continuationBaselineCompleted: number
}

export type GoalSnapshot = Omit<
  Goal,
  | "lastAccountedAt"
  | "autoTurns"
  | "lastContinuationAt"
  | "sessionTokensAtCreation"
  | "lastSessionTokens"
> & {
  remainingTokens: number | null
  sampledAt: number
  autoTurns: number
  lastContinuationAt: number | null
}

export type CreateGoalOptions = {
  tokenBudget?: number | null
  maxAutoTurns?: number | null
  maxDurationSeconds?: number | null
  noProgressTokenThreshold?: number | null
  maxNoProgressTurns?: number | null
  maxPromptFailures?: number | null
  agent?: string | null
  initialStatus?: MutableGoalStatus
  /** Cumulative session tokens observed immediately before creating the goal. */
  sessionTokensAtCreation?: number | null
}

export type ExtendGoalOptions = {
  tokenBudget?: number | null
  maxAutoTurns?: number | null
  maxDurationSeconds?: number | null
}

/**
 * One assistant turn's observed output, as the progress scorer receives it.
 *
 * The goal's own `noProgressTokenThreshold` and `maxNoProgressTurns` are deliberately NOT overridable
 * here: they are the values the goal was created with, and the plugin option of the same name is
 * already folded into the goal as the default for a goal that did not ask. An override field here put
 * the OPTION ahead of the goal on every scored turn; see `recordAssistantProgress`.
 */
export type AssistantProgressInput = {
  messageID?: string
  text?: string
  outputTokens?: number | null
  evaluateContinuation?: boolean
  toolCalls?: number | null
}

const HistoryEntrySchema = Schema.Struct({
  type: Schema.Literals([
    "created",
    "updated",
    "extended",
    "paused",
    "resumed",
    "completed",
    "unmet",
    "autoContinue",
    "checkpoint",
    "progress",
    "warning",
    "limited",
    "error",
  ]),
  detail: Schema.String,
  timestamp: Schema.Number,
})
const CheckpointSchema = Schema.Struct({
  summary: Schema.String,
  timestamp: Schema.Number,
})
const NullableString = Schema.optional(Schema.NullOr(Schema.String))
const NullableNumber = Schema.optional(Schema.NullOr(Schema.Number))
const GoalSchema = Schema.Struct({
  sessionID: Schema.String,
  objective: Schema.String,
  status: Schema.Literals([
    "active",
    "paused",
    "budgetLimited",
    "usageLimited",
    "complete",
    "unmet",
  ]),
  tokenBudget: NullableNumber,
  tokensUsed: Schema.Number,
  sessionTokensAtCreation: Schema.optional(Schema.Number),
  lastSessionTokens: Schema.optional(Schema.Number),
  timeUsedSeconds: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  completionEvidence: NullableString,
  blocker: NullableString,
  closedAt: NullableNumber,
  lastAccountedAt: NullableNumber,
  autoTurns: Schema.Number,
  lastContinuationAt: NullableNumber,
  continuationFailures: Schema.optional(Schema.Number),
  lastStatus: NullableString,
  maxAutoTurns: NullableNumber,
  maxDurationSeconds: NullableNumber,
  noProgressTokenThreshold: NullableNumber,
  maxNoProgressTurns: NullableNumber,
  // Optional so goals persisted before this field existed still decode; normalizeGoal
  // fills the null fallback on the next mutate.
  maxPromptFailures: Schema.optional(NullableNumber),
  noProgressTurns: Schema.optional(Schema.Number),
  budgetWrapupSent: Schema.optional(Schema.Boolean),
  stopReason: NullableString,
  history: Schema.optional(Schema.Array(HistoryEntrySchema)),
  checkpoints: Schema.optional(Schema.Array(CheckpointSchema)),
  // Optional so goals persisted before these fields existed still decode; normalizeGoal fills the
  // empty/zero defaults on the next mutate.
  completed: Schema.optional(Schema.Array(Schema.String)),
  continuationBaselineCompleted: Schema.optional(Schema.Number),
  lastCheckpoint: Schema.optional(Schema.NullOr(CheckpointSchema)),
  lastAssistantText: Schema.optional(Schema.String),
  lastAssistantMessageID: Schema.optional(Schema.String),
  lastPromptAgent: NullableString,
  awaitingContinuationProgress: Schema.optional(Schema.Boolean),
  continuationBaselineMessageID: Schema.optional(Schema.String),
  continuationBaselineSummary: Schema.optional(Schema.String),
})
export const StateSchema = Schema.Struct({
  version: Schema.Literal(1),
  goals: Schema.Record(Schema.String, GoalSchema),
})

export type State = { version: 1; goals: Record<string, Goal> }

export class GoalError extends Data.TaggedError("GoalError")<{ readonly message: string }> {}
export class GoalReportError extends Data.TaggedError("GoalReportError")<{ readonly message: string }> {}

export type GoalReport = {
  status: "complete" | "blocked"
  reason: string
}

export type GoalSessionControlHandle = {
  current: () => boolean
  running: () => boolean
}

export type GoalReportHandler = (sessionID: string, messageID: string, report: GoalReport) => boolean
export type GoalAvailable = (sessionID: string, tool: string) => boolean

