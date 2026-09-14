import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"

export const GOAL_SYSTEM_MARKER = "OpenCode goal mode"
export const GOAL_METADATA_KEY = "opencode.goal"
export const GOAL_MAX_OBJECTIVE = 10_000

export type GoalStatus = "active" | "paused" | "complete" | "blocked" | "unmet"

export type GoalMetadata = {
  text: string
  status: GoalStatus
  active: boolean
  reason: string
}

export type GoalReport = {
  status: "complete" | "blocked"
  reason: string
}

export type GoalInput = {
  sessionID: string
  messageID: string
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  arguments: string
  parts?: unknown[]
  snapshotInitialization?: boolean
}

export type GoalCommandResult = {
  info: { role: "assistant" }
  parts: { type: "text"; text: string }[]
}

export type GoalPause = (sessionID: string, force: boolean) => Promise<void>

export type GoalSessionControlHandle = {
  current: () => boolean
  running: () => boolean
}

export type GoalReportHandler = (sessionID: string, messageID: string, report: GoalReport) => boolean

export type GoalAvailable = (sessionID: string, tool: string) => boolean

export interface GoalServiceInterface {
  readonly command: (input: GoalInput) => Promise<GoalCommandResult>
  readonly pause: (sessionID: string, force: boolean) => Promise<void>
  readonly cancel: (sessionID: string, force: boolean) => Promise<void>
  readonly start: (sessionID: string, pause: GoalPause) => Promise<void>
  readonly active: (sessionID: string) => boolean
  readonly read: (sessionID: string) => GoalMetadata | null
  readonly available: GoalAvailable
  readonly report: GoalReportHandler
  readonly bind: <T>(input: GoalInput, effect: Promise<T>) => Promise<T>
}

export * as GoalService from "./impl"