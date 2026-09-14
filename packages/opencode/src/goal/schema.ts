import { Data, Effect, Schema } from "effect"

export const GOAL_SYSTEM_MARKER = "OpenCode goal mode"
export const GOAL_METADATA_KEY = "opencode.goal"

export const GOAL_MAX_OBJECTIVE = 4000
export const GOAL_MAX_EVIDENCE = 4000
export const GOAL_HISTORY_LIMIT = 50
export const GOAL_CHECKPOINT_LIMIT = 8
export const GOAL_CHECKPOINT_CHAR_LIMIT = 280
export const GOAL_DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD = 50
export const GOAL_DEFAULT_MAX_NO_PROGRESS_TURNS = 2
export const GOAL_DEFAULT_MAX_AUTO_TURNS = 25
export const GOAL_DEFAULT_CONTINUE_INTERVAL_SECONDS = 3
export const GOAL_DEFAULT_MAX_PROMPT_FAILURES = 3

export type GoalStatus = "active" | "paused" | "budgetLimited" | "usageLimited" | "complete" | "unmet"
export type MutableGoalStatus = "active" | "paused"
export type GoalHistoryType =
  | "created"
  | "updated"
  | "paused"
  | "resumed"
  | "completed"
  | "unmet"
  | "autoContinue"
  | "checkpoint"
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
  noProgressTurns: number
  budgetWrapupSent: boolean
  stopReason: string | null
  history: GoalHistoryEntry[]
  checkpoints: GoalCheckpoint[]
  lastCheckpoint: GoalCheckpoint | null
  lastAssistantText: string
  lastAssistantMessageID: string
  lastPromptAgent: string | null
  awaitingContinuationProgress: boolean
  continuationBaselineMessageID: string
  continuationBaselineSummary: string
}

export type GoalSnapshot = Omit<Goal, "lastAccountedAt" | "autoTurns" | "lastContinuationAt"> & {
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
  agent?: string | null
  initialStatus?: MutableGoalStatus
}

export type AssistantProgressInput = {
  messageID?: string
  text?: string
  outputTokens?: number | null
  noProgressTokenThreshold?: number | null
  maxNoProgressTurns?: number | null
  evaluateContinuation?: boolean
}

const HistoryEntrySchema = Schema.Struct({
  type: Schema.Literals([
    "created",
    "updated",
    "paused",
    "resumed",
    "completed",
    "unmet",
    "autoContinue",
    "checkpoint",
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
  noProgressTurns: Schema.optional(Schema.Number),
  budgetWrapupSent: Schema.optional(Schema.Boolean),
  stopReason: NullableString,
  history: Schema.optional(Schema.Array(HistoryEntrySchema)),
  checkpoints: Schema.optional(Schema.Array(CheckpointSchema)),
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

