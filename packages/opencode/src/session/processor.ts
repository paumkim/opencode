import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Deferred, Duration, Effect, Exit, Layer, Context, Scope, Schema } from "effect"
import * as Stream from "effect/Stream"
import path from "node:path"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import { Checkpoint } from "@/checkpoint/checkpoint"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { ulid } from "ulid"
import { PseudoToolCall } from "./pseudo-tool-call"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { Usage, type LLMEvent } from "@opencode-ai/llm"

const DOOM_LOOP_THRESHOLD = 3
const TEXT_LOOP_THRESHOLD = 3
const REASONING_LOOP_THRESHOLD = 3
const NO_EDIT_STREAK_THRESHOLD = 3
const CHURN_STREAK_THRESHOLD = 3
const OSCILLATION_WINDOW = 8
const OSCILLATION_UNIQUE_RATIO = 0.35
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch"])

// Alternation detection: a model that bounces between two states (e.g. text A
// → text B → text A → text B) never produces three consecutive identical
// outputs, so the text/reasoning streak detectors miss it. Track the last N
// turn signatures and flag when the pattern is a strict alternation.
const ALTERNATION_WINDOW = 6
const ALTERNATION_MIN_UNIQUE = 2

// Build a stable fingerprint for a tool call so we can detect cycles that
// aren't strictly consecutive (e.g. read A → read B → read A → read B).
function toolFingerprint(toolName: string, input: unknown): string {
  const record = isRecord(input) ? input : { value: input }
  const filePath =
    typeof record.file_path === "string"
      ? record.file_path
      : typeof record.path === "string"
        ? record.path
        : typeof record.filePath === "string"
          ? record.filePath
          : ""
  const command =
    typeof record.command === "string"
      ? record.command
      : typeof record.cmd === "string"
        ? record.cmd
        : ""
  return `${toolName}:${filePath || command}`
}

// Record a turn signature into the rolling per-session window and flag a
// strict alternation (A → B → A → B) that the consecutive-identity detectors
// miss. A signature is only recorded when the turn produced real content.
function recordTurnSignature(
  map: Map<SessionID, string[]>,
  sessionID: SessionID,
  signature: string,
): boolean {
  const window = map.get(sessionID) ?? []
  const next = [...window, signature].slice(-ALTERNATION_WINDOW)
  map.set(sessionID, next)
  if (next.length < ALTERNATION_MIN_UNIQUE + 1) return false
  // Strict alternation: exactly two distinct values, each appearing at least
  // twice, interleaved with no repeats.
  const unique = new Set(next)
  if (unique.size !== ALTERNATION_MIN_UNIQUE) return false
  const [a, b] = unique
  if (next.filter((s) => s === a).length < 2 || next.filter((s) => s === b).length < 2) return false
  for (let i = 1; i < next.length; i++) if (next[i] === next[i - 1]) return false
  return true
}

export type Result = "compact" | "stop" | "continue"

export interface ProcessResult {
  result: Result
  noEditStreak: number
}

export interface Handle {
  readonly message: SessionV1.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: SessionV1.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<ProcessResult>
  readonly loopDetected: boolean
  readonly noEditStreak: number
  readonly loopReason: "doom" | "text" | "no_edit" | "churn" | "oscillation" | "reasoning" | "alternation" | "none"
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: SessionV1.TextPart | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
  loopDetected: boolean
  turnSignature: string
  hasEditInStep: boolean
  stateChanged: boolean
  alternationDetected: boolean
  noEditStreak: number
  churnStreak: number
  churnTarget: string
  recentTools: string[]
}

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const checkpoint = yield* Checkpoint.Service
    const database = yield* Database.Service

    // Repetition streaks persist across turns. create() runs once per
    // assistant message, so per-turn state cannot catch a model that repeats
    // identical text or reasoning across prompts. These are keyed by session
    // and reset only when the model takes real progress (a tool call).
    const textLoop = new Map<SessionID, { text: string; count: number }>()
    const reasoningLoop = new Map<SessionID, { text: string; count: number }>()
    // Rolling window of turn signatures per session, used to detect strict
    // alternation (A → B → A → B) that the consecutive-identity detectors miss.
    const turnSignatures = new Map<SessionID, string[]>()

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
reasoningMap: {},
        loopDetected: false,
        turnSignature: "",
        hasEditInStep: false,
        stateChanged: false,
        alternationDetected: false,
        noEditStreak: 0,
        churnStreak: 0,
        churnTarget: "",
        recentTools: [],
      }
      let aborted = false

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return undefined
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: SessionV1.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            // Keep metadata streamed while running so failures retain progress detail (e.g. execute's child calls).
            metadata: match.part.state.metadata,
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const saveToolLearning = Effect.fn("SessionProcessor.saveToolLearning")(function* (input: {
        tool: string
        sessionID: string
        success: boolean
        error?: string
        output?: string
        args?: any
      }) {
        try {
          const home = globalThis.process.env.HOME ?? "/root"
          const file = path.join(home, ".term", ".agents", "data", "term-memory", "tool-learnings.jsonl")
          const entry = {
            time: new Date().toISOString(),
            sessionID: input.sessionID,
            tool: input.tool,
            success: input.success,
            error: input.error,
            output: input.output,
            args: input.args,
          }
          const line = JSON.stringify(entry) + "\n"
          yield* Effect.tryPromise({
            try: async () => {
              const fs = await import("node:fs/promises")
              await fs.mkdir(path.join(home, ".term", ".agents", "data", "term-memory"), { recursive: true })
              await fs.appendFile(file, line, "utf-8")
            },
            catch: (e) => new Error(String(e)),
          }).pipe(Effect.ignore)
        } catch {
          // Never let learning failures affect tool execution
        }
      })

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        if (!(reasoningID in ctx.reasoningMap)) return
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        delete ctx.reasoningMap[reasoningID]
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        const existing = yield* readToolCall(input.id)
        if (existing) {
          if (!input.providerExecuted || existing.part.metadata?.providerExecuted) return existing
          const part = yield* session.updatePart({
            ...existing.part,
            metadata: { ...existing.part.metadata, providerExecuted: true },
          })
          ctx.toolcalls[input.id] = {
            ...existing.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return { call: ctx.toolcalls[input.id], part }
        }
        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: input.name,
          callID: input.id,
          state: { status: "pending", input: {}, raw: "" },
          metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
        } satisfies SessionV1.ToolPart)
        ctx.toolcalls[input.id] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return { call: ctx.toolcalls[input.id], part }
      })

      const isFilePart = (value: unknown): value is SessionV1.FilePart => Schema.is(SessionV1.FilePart)(value)

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: SessionV1.FilePart[] } => {
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

case "reasoning-end": {
               if (value.providerMetadata && value.id in ctx.reasoningMap) {
                 ctx.reasoningMap[value.id].metadata = value.providerMetadata
               }
const reasoning = ctx.reasoningMap[value.id]
                if (reasoning?.text.trim()) {
                  ctx.turnSignature = `reasoning:${reasoning.text}`
                  const key = ctx.sessionID
                  const entry = reasoningLoop.get(key) ?? { text: reasoning.text, count: 0 }
                  if (entry.text === reasoning.text) {
                    entry.count++
                  } else {
                    entry.text = reasoning.text
                    entry.count = 1
                  }
                  reasoningLoop.set(key, entry)
                  if (entry.count >= REASONING_LOOP_THRESHOLD) {
                    ctx.loopDetected = true
                    yield* Effect.logError("reasoning_loop", {
                      "session.id": ctx.sessionID,
                      messageID: ctx.assistantMessage.id,
                      text: reasoning.text.slice(0, 200),
                      count: entry.count,
                    })
                  }
                }
                yield* finishReasoning(value.id)
                return
              }

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            yield* ensureToolCall(value)
            return

          case "tool-input-end": {
            yield* ensureToolCall(value)
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            const input = isRecord(value.input) ? value.input : { value: value.input }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            // Track whether this step produced a file edit. Models that
            // only read/search/delete without ever editing will churn
            // indefinitely on newer, less-instructed model generations.
            if (EDIT_TOOLS.has(value.name)) ctx.hasEditInStep = true

            // Churn: editing the same file over and over without net progress.
            // A write that merely reverts the previous edit shouldn't reset
            // the streak — it's still spinning, just in a different direction.
            if (EDIT_TOOLS.has(value.name)) {
              const fp = toolFingerprint(value.name, input)
              ctx.churnStreak = fp === ctx.churnTarget ? ctx.churnStreak + 1 : 1
              ctx.churnTarget = fp
              if (ctx.churnStreak >= CHURN_STREAK_THRESHOLD) {
                ctx.loopDetected = true
                yield* Effect.logError("churn_loop", {
                  "session.id": ctx.sessionID,
                  messageID: ctx.assistantMessage.id,
                  file: fp,
                  streak: ctx.churnStreak,
                })
              }
            }

            // Oscillation: cycling between a small set of tools/files without
            // ever landing. Unlike doom_loop this catches non-consecutive
            // repeats (read A → read B → read A → read B).
            ctx.recentTools = [...ctx.recentTools, toolFingerprint(value.name, input)].slice(
              -OSCILLATION_WINDOW,
            )
            if (ctx.recentTools.length >= OSCILLATION_WINDOW) {
              const unique = new Set(ctx.recentTools).size
              if (unique / ctx.recentTools.length <= OSCILLATION_UNIQUE_RATIO) {
                ctx.loopDetected = true
                yield* Effect.logError("oscillation_loop", {
                  "session.id": ctx.sessionID,
                  messageID: ctx.assistantMessage.id,
                  unique,
                  total: ctx.recentTools.length,
                  tools: [...new Set(ctx.recentTools)].join(","),
                })
              }
            }

            const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.name],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.name, input },
              always: [value.name],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.id)
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            yield* completeToolCall(value.id, output)
            ctx.stateChanged = true
            const toolName = toolCall?.part.tool ?? value.name
            yield* saveToolLearning({
              tool: toolName,
              sessionID: ctx.sessionID,
              success: true,
              output: rawOutput.output,
              args: input,
            }).pipe(Effect.ignore)
            return
          }

          case "tool-error": {
            const errToolCall = yield* readToolCall(value.id)
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            yield* saveToolLearning({
              tool: errToolCall?.part.tool ?? value.name,
              sessionID: ctx.sessionID,
              success: false,
              error: errorMessage(value.error ?? new Error(value.message)),
              args: errToolCall?.part.state.input,
            }).pipe(Effect.ignore)
            return
          }

          case "provider-error":
            throw new Error(value.message)

          case "step-start":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "step-finish": {
            const completedSnapshot = yield* snapshot.track()
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            ctx.assistantMessage.finish = value.reason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                ctx.hasEditInStep = true
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            if (ctx.hasEditInStep) {
              yield* checkpoint
                .create({
                  sessionID: ctx.sessionID,
                  task: ctx.assistantMessage.parentID ?? ctx.sessionID,
                  accomplishments: ctx.currentText?.text
                    ? [ctx.currentText.text.slice(0, 200)]
                    : [],
                  nextSteps: [],
                  context: {
                    hasEditInStep: ctx.hasEditInStep,
                    noEditStreak: ctx.noEditStreak,
                    model: ctx.model.id,
                    agent: ctx.assistantMessage.agent,
                  },
                })
                .pipe(Effect.ignore, Effect.forkIn(scope))
            }
            return
          }

          case "text-start":
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            // Opt-out fallback: some models emit pseudo XML <tool_call>
            // instead of real tool calls. Recover them as running tool
            // parts so downstream execution still happens. Safe to run
            // always: distinctive patterns never appear in normal prose.
            // Set OPENCODE_PSEUDO_TOOL_CALL=0 to disable.
            if (globalThis.process.env.OPENCODE_PSEUDO_TOOL_CALL !== "0") {
              // Allowlist: only execute parsed calls for known registry tools.
              // Unknown names stay as visible text (strip preserves them) so
              // smuggled <tool_call name="..."> markup cannot trigger arbitrary
              // tool execution via parser injection.
              const pseudo = PseudoToolCall.parsePseudoToolCalls(ctx.currentText.text).filter((call) =>
                PseudoToolCall.isKnownToolCall(call.name),
              )
              for (const call of pseudo) {
                const id = ulid()
                yield* ensureToolCall({ id, name: call.name })
                const input = isRecord(call.input) ? call.input : { value: call.input }
                yield* updateToolCall(id, (match) => ({
                  ...match,
                  tool: call.name,
                  state:
                    match.state.status === "running"
                      ? { ...match.state, input }
                      : { status: "running", input, time: { start: Date.now() } },
                }))
              }
              if (pseudo.length) ctx.currentText.text = PseudoToolCall.stripPseudoToolCalls(ctx.currentText.text)
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
if (ctx.currentText.text.trim()) {
                ctx.turnSignature = `text:${ctx.currentText.text}`
                const key = ctx.sessionID
                const entry = textLoop.get(key) ?? { text: ctx.currentText.text, count: 0 }
               if (entry.text === ctx.currentText.text) {
                 entry.count++
               } else {
                 entry.text = ctx.currentText.text
                 entry.count = 1
               }
               textLoop.set(key, entry)
               if (entry.count >= TEXT_LOOP_THRESHOLD) {
                 ctx.loopDetected = true
                 yield* Effect.logError("text_loop", {
                   "session.id": ctx.sessionID,
                   messageID: ctx.assistantMessage.id,
                   text: ctx.currentText.text,
                   count: entry.count,
                 })
               }
             }
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return

          case "finish":
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        yield* Effect.logError("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
          error: errorMessage(e),
          stack: e instanceof Error ? e.stack : undefined,
        })
        const error = parse(e)
        if (SessionV1.ContextOverflowError.isInstance(error)) {
          if ((yield* config.get()).compaction?.auto === false && !ctx.assistantMessage.summary) {
            ctx.assistantMessage.error = error
            ctx.assistantMessage.finish = "error"
            yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            yield* status.set(ctx.sessionID, { type: "idle" })
            return
          }
          ctx.needsCompaction = true
          yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = error
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            ctx.loopDetected = false
            ctx.alternationDetected = false
            ctx.turnSignature = ""
            ctx.stateChanged = false
            yield* status.set(ctx.sessionID, { type: "busy" })
            const stream = llm.stream(streamInput)

            const streamDelay = (yield* config.get()).experimental?.stream_delay ?? 0

            yield* stream.pipe(
              Stream.mapEffect((event) => {
                if (streamDelay > 0 && (event.type === "text-delta" || event.type === "reasoning-delta")) {
                  return Effect.sleep(Duration.millis(streamDelay)).pipe(Effect.as(event))
                }
                return Effect.succeed(event)
              }),
              Stream.tap((event) => handleEvent(event)),
              Stream.takeUntil(() => ctx.needsCompaction),
              Stream.runDrain,
            )
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.retry(
              SessionRetry.policy({
                provider: input.model.providerID,
                parse,
                set: (info) => {
                  return status.set(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    message: info.message,
                    action: info.action,
                    next: info.next,
                  })
                },
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsCompaction) return { result: "compact" as const, noEditStreak: ctx.noEditStreak }
          if (ctx.blocked || ctx.assistantMessage.error)
            return { result: "stop" as const, noEditStreak: ctx.noEditStreak }
          // Record the turn signature and check for strict alternation
          // (A → B → A → B) that the consecutive-identity detectors miss.
          if (ctx.turnSignature) {
            if (recordTurnSignature(turnSignatures, ctx.sessionID, ctx.turnSignature)) {
              ctx.loopDetected = true
              ctx.alternationDetected = true
              yield* Effect.logError("alternation_loop", {
                "session.id": ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                signature: ctx.turnSignature,
              })
            }
          }
          // Real progress (a tool result that changed state, or a file patch)
          // clears the cross-turn repetition streaks. Without this a model that
          // breaks out of a text/reasoning loop for one turn then falls back
          // into it keeps accumulating and never trips the threshold. The
          // alternation window is intentionally NOT reset here: a model that
          // alternates text A/B across turns, even with tool calls in between,
          // should still be caught.
          if (ctx.stateChanged) {
            textLoop.delete(ctx.sessionID)
            reasoningLoop.delete(ctx.sessionID)
          }
          const noEditStreak = ctx.hasEditInStep ? 0 : ctx.noEditStreak + 1
          ctx.noEditStreak = noEditStreak
          if (noEditStreak >= NO_EDIT_STREAK_THRESHOLD) {
            ctx.loopDetected = true
            yield* Effect.logError("no_edit_loop", {
              "session.id": input.sessionID,
              messageID: input.assistantMessage.id,
              streak: noEditStreak,
            })
          }
          ctx.hasEditInStep = false
          return { result: "continue" as const, noEditStreak }
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        get loopDetected() {
          return ctx.loopDetected
        },
        get noEditStreak() {
          return ctx.noEditStreak
        },
get loopReason() {
            if (!ctx.loopDetected) return "none"
            // Most specific detectors first: a model that is repeating
            // identical reasoning or text across turns is in a content loop,
            // not a tool-call loop, so it deserves the matching message.
            if (ctx.alternationDetected) return "alternation"
            if (textLoop.get(ctx.sessionID)?.count && textLoop.get(ctx.sessionID)!.count >= TEXT_LOOP_THRESHOLD) return "text"
            if (reasoningLoop.get(ctx.sessionID)?.count && reasoningLoop.get(ctx.sessionID)!.count >= REASONING_LOOP_THRESHOLD) return "reasoning"
            if (ctx.churnStreak >= CHURN_STREAK_THRESHOLD) return "churn"
            if (ctx.recentTools.length >= OSCILLATION_WINDOW) {
              const unique = new Set(ctx.recentTools).size
              if (unique / ctx.recentTools.length <= OSCILLATION_UNIQUE_RATIO) return "oscillation"
            }
            if (ctx.noEditStreak >= NO_EDIT_STREAK_THRESHOLD) return "no_edit"
            return "doom"
          },
        updateToolCall,
        completeToolCall,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Session.node,
    Config.node,
    Snapshot.node,
    Agent.node,
    LLM.node,
    Permission.node,
    Plugin.node,
    SessionSummary.node,
    SessionStatus.node,
    Image.node,
    EventV2Bridge.node,
    Checkpoint.node,
    Database.node,
  ],
})

export * as SessionProcessor from "./processor"
