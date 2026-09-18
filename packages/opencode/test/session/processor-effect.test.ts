import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { APICallError, jsonSchema, tool, type ModelMessage } from "ai"
import { Config } from "@/config/config"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { TestInstance, provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const waitFor = <A>(check: Effect.Effect<A | undefined>, message: string) =>
  Effect.gen(function* () {
    const stop = Date.now() + 500
    while (Date.now() < stop) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(message))
  })

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const root = LayerNode.group([
  Config.node,
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const
const env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  replacements,
)

const it = testEffect(env)

it.live("preflight requests compaction before provider invocation without retry or loop signals", () =>
  provideTmpdirServer(
    ({ dir, llm }) => Effect.gen(function* () {
      const { processors, session, provider } = yield* boot()
      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "x".repeat(300_000))
      const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
      delete msg.finish
      const model = yield* provider.getModel(ref.providerID, ref.modelID)
      const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model })
      const value = yield* handle.process({
        user: parent,
        sessionID: chat.id,
        model,
        agent: agent(),
        system: [],
        messages: [{ role: "user", content: "x".repeat(300_000) }],
        tools: {},
      })
      expect(value).toMatchObject({ result: "compact", noEditStreak: 0, runaway: false })
      expect(yield* llm.calls).toBe(0)
      expect(handle.message.error).toBeUndefined()
      expect(handle.message.finish).toBeUndefined()
      expect(handle.message.time.completed).toBeDefined()
      expect(handle.loopDetected).toBe(false)
      expect(yield* MessageV2.parts(msg.id)).toEqual([])
    }),
    { config: (url) => ({ ...providerCfg(url), compaction: { threshold: 0.75 } }) },
  ),
)

const large = "x".repeat(300_000)
const continuation: ModelMessage[] = [
  { role: "user", content: large },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "done", toolName: "lookup", input: {} }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "done", toolName: "lookup", output: { type: "text", value: "done" } }] },
]
const preflightCases: Array<{
  name: string
  compact: boolean
  compaction?: { auto?: boolean; threshold?: number; reserved?: number }
  messages?: ModelMessage[]
  tools?: LLM.StreamInput["tools"]
  limit?: { context: number; input?: number; output: number }
  summary?: boolean
  preflight?: boolean
  continuation?: boolean
  system?: string[]
}> = [
  { name: "enabled", compact: true },
  { name: "auto disabled", compact: false, compaction: { auto: false, threshold: 0.75 } },
  { name: "threshold absent", compact: false, compaction: {} },
  { name: "threshold out of range", compact: false, compaction: { threshold: 2 } },
  { name: "unknown context", compact: false, limit: { context: 0, output: 10_000 } },
  { name: "summary bypass", compact: false, summary: true },
  { name: "attempt already made", compact: false, preflight: false },
  { name: "fits capacity", compact: false, messages: [{ role: "user", content: "hi" }] },
  { name: "output reserve", compact: true, compaction: { threshold: 1 }, limit: { context: 100_000, output: 32_000 }, messages: [{ role: "user", content: "x".repeat(220_000) }] },
  { name: "input capacity", compact: true, limit: { context: 400_000, input: 100_000, output: 10_000 } },
  { name: "configured reserve", compact: true, compaction: { threshold: 1, reserved: 50_000 }, limit: { context: 400_000, input: 100_000, output: 10_000 }, messages: [{ role: "user", content: "x".repeat(180_000) }] },
  { name: "system prompt counted", compact: true, messages: [{ role: "user", content: "hi" }], system: [large] },
  { name: "JSON schema counted", compact: true, messages: [{ role: "user", content: "hi" }], tools: { lookup: tool({ inputSchema: jsonSchema({ type: "object", description: large }) }) } },
  { name: "Zod schema counted", compact: true, messages: [{ role: "user", content: "hi" }], tools: { lookup: tool({ inputSchema: z.object({ query: z.string().describe(large) }) }) } },
  { name: "tool continuation protected", compact: false, messages: continuation, continuation: true },
  { name: "new user after tool permits compaction", compact: true, messages: [...continuation, { role: "user", content: "next" }], continuation: false },
  { name: "encoded image normalized", compact: false, messages: [{ role: "user", content: [{ type: "image", image: `data:image/png;base64,${large}` }] }] },
  { name: "binary image normalized", compact: false, messages: [{ role: "user", content: [{ type: "image", image: new Uint8Array(300_000) }] }] },
  { name: "encoded file normalized", compact: false, messages: [{ role: "user", content: [{ type: "file", mediaType: "image/png", data: large }] }] },
  { name: "text beside media counted", compact: true, messages: [{ role: "user", content: [{ type: "text", text: large }, { type: "image", image: "data:image/png;base64,eA==" }] }] },
  { name: "opaque reasoning normalized", compact: false, messages: [{ role: "assistant", content: [{ type: "reasoning", text: "thinking", providerOptions: { openai: { reasoningEncryptedContent: large } } }] }, { role: "user", content: "next" }] },
]
for (const item of preflightCases) {
  it.live(`preflight production seam: ${item.name}`, () => provideTmpdirServer(
    ({ dir, llm }) => Effect.gen(function* () {
      const config = yield* Config.Service
      expect((yield* config.get()).compaction?.threshold).toBe((item.compaction ?? { threshold: 0.75 }).threshold)
      const { processors, session, provider } = yield* boot()
      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "request")
      const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
      delete msg.finish
      msg.summary = item.summary
      const base = yield* provider.getModel(ref.providerID, ref.modelID)
      const model = { ...base, limit: item.limit ?? base.limit }
      const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model })
      yield* llm.push(reply().text("done").stop())
      const value = yield* handle.process({
        user: parent, sessionID: chat.id, model, agent: agent(), system: item.system ?? [],
        messages: item.messages ?? [{ role: "user", content: large }], tools: item.tools ?? {}, preflight: item.preflight,
        continuation: item.continuation,
      })
      expect(value.result).toBe(item.compact ? "compact" : "continue")
      expect(value.preflight).toBe(item.compact ? true : undefined)
      expect(yield* llm.calls).toBe(item.compact ? 0 : 1)
      expect(handle.message.error).toBeUndefined()
      expect(handle.loopDetected).toBe(false)
    }),
    { config: (url) => ({ ...providerCfg(url), compaction: item.compaction ?? { threshold: 0.75 } }) },
  ))
}

const providerErrorLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
        LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
        LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {}, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-1",
          name: "lookup",
          result: { type: "error", value: "provider boom" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const providerErrorEnv = LayerNode.compile(root, [...replacements, [LLM.node, providerErrorLLM]])
const itProviderError = testEffect(providerErrorEnv)

const fragmentFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "thinking" }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "partial" }),
        LLMEvent.providerError({ message: "provider boom" }),
      ),
  }),
)
const fragmentFailureEnv = LayerNode.compile(root, [...replacements, [LLM.node, fragmentFailureLLM]])
const itFragmentFailure = testEffect(fragmentFailureEnv)

const textLoopLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "same" }),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.textStart({ id: "text-2" }),
        LLMEvent.textDelta({ id: "text-2", text: "same" }),
        LLMEvent.textEnd({ id: "text-2" }),
        LLMEvent.textStart({ id: "text-3" }),
        LLMEvent.textDelta({ id: "text-3", text: "same" }),
        LLMEvent.textEnd({ id: "text-3" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const textLoopEnv = LayerNode.compile(root, [...replacements, [LLM.node, textLoopLLM]])
const itTextLoop = testEffect(textLoopEnv)

// Pushable LLM used by tests that need to drive multiple distinct turns.
// The queue lives in module-level state so test helpers can push into it
// without extending the LLM.Service interface.
const noEditQueues: LLMEvent[][] = []
function pushLLM(events: LLMEvent[]) {
  noEditQueues.push(events)
}
const noEditLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.fromEffect(
        Effect.sync(() => {
          const q = noEditQueues.shift() ?? []
          if (q.length) return q
          return [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          ]
        }),
      ).pipe(Stream.flatMap(Stream.fromIterable)),
  }),
)
const noEditEnv = LayerNode.compile(root, [...replacements, [LLM.node, noEditLLM]])
const itNoEdit = testEffect(noEditEnv)

function textTurn(text: string): LLMEvent[] {
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text-1" }),
    LLMEvent.textDelta({ id: "text-1", text }),
    LLMEvent.textEnd({ id: "text-1" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ]
}

function toolTurn(name: string, input: Record<string, unknown>): LLMEvent[] {
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id: "call-1", name }),
    LLMEvent.toolInputEnd({ id: "call-1", name }),
    LLMEvent.toolCall({ id: "call-1", name, input, providerExecuted: false }),
    LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ]
}

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// Finite scripts fail immediately if the processor invokes the provider unexpectedly.
function emptyRecoveryTest(name: string, scripts: (LLMEvent[] | APICallError)[], expected: { calls: number; exhausted?: boolean; cancel?: boolean; providerExhausted?: boolean }) {
  let calls = 0
  const scripted = Layer.succeed(LLM.Service, LLM.Service.of({
    stream: () => {
      const events = scripts[calls++]
      if (events instanceof APICallError) return Stream.fail(events)
      return events ? Stream.fromIterable(events) : Stream.die(new Error("Unexpected provider invocation"))
    },
  }))
  testEffect(LayerNode.compile(root, [...replacements, [LLM.node, scripted]])).live(
    `empty recovery: ${name}`,
    () => provideTmpdirInstance((dir) => Effect.gen(function* () {
      calls = 0
      const { processors, session, provider } = yield* boot()
      const status = yield* SessionStatus.Service
      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "request")
      const msg = yield* assistant(chat.id, parent.id, dir)
      delete msg.finish
      msg.cost = 7
      msg.tokens.input = 11
      const prior = yield* session.updatePart({
        id: PartID.ascending(), messageID: msg.id, sessionID: chat.id, type: "text", text: "prior history",
      })
      const model = yield* provider.getModel(ref.providerID, ref.modelID)
      const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model })
      const run = handle.process({
        user: parent, sessionID: chat.id, model, agent: agent(), system: [],
        messages: [{ role: "user", content: "request" }], tools: {},
      })
      if (expected.cancel) {
        const fiber = yield* run.pipe(Effect.forkChild)
        yield* waitFor(status.get(chat.id).pipe(Effect.map((s) => s.type === "retry" ? true : undefined)), "missing empty retry status")
        yield* Fiber.interrupt(fiber)
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
      } else {
        const result = yield* run
        expect(result.result).toBe(expected.exhausted || expected.providerExhausted ? "stop" : "continue")
        expect(result.noEditStreak).toBe(expected.exhausted || expected.providerExhausted ? 0 : 1)
        if (expected.providerExhausted) {
          expect(handle.message.error).toMatchObject({ name: "APIError", data: { message: "scripted provider failure", statusCode: 503 } })
        } else if (expected.exhausted) {
          expect(handle.message.error).toMatchObject({ data: { message: "Provider returned an empty response after 2 retries" } })
          expect(handle.message.finish).toBe("error")
        } else {
          expect(handle.message.error).toBeUndefined()
        }
      }
      expect(calls).toBe(expected.calls)
      expect(handle.loopDetected).toBe(false)
      expect(handle.message.time.completed).toBeDefined()
      const parts = yield* MessageV2.parts(msg.id)
      expect(parts.find((part) => part.id === prior.id)).toEqual(prior)
      if (expected.exhausted || expected.cancel || expected.providerExhausted) {
        expect(parts).toEqual([prior])
        expect(handle.message.cost).toBe(7)
        expect(handle.message.tokens.input).toBe(11)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error).toEqual(handle.message.error)
          expect(stored.info.finish).toBe(handle.message.finish)
          expect(stored.info.tokens).toEqual({ total: 0, input: 11, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
          expect(stored.info.cost).toBe(7)
        }
        expect(yield* status.get(chat.id)).toMatchObject({ type: "idle" })
      } else if (expected.calls > 1) {
        expect(parts.filter((part) => part.type === "step-start")).toHaveLength(1)
        expect(parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["prior history", "recovered"])
      }
    }), { config: cfg }),
    60000,
  )
}

const unfinishedEmpty = [LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "empty" })]
emptyRecoveryTest("empty then text removes unfinished empty step", [unfinishedEmpty, textTurn("recovered")], { calls: 2 })
emptyRecoveryTest("three empties exhaust exactly two retries", [
  unfinishedEmpty,
  [LLMEvent.stepStart({ index: 0 }), LLMEvent.stepFinish({ index: 0, reason: "unknown", usage: { inputTokens: 0 } }), LLMEvent.finish({ reason: "unknown" })],
  [],
], { calls: 3, exhausted: true })
emptyRecoveryTest("valid text never retries", [textTurn("valid")], { calls: 1 })
emptyRecoveryTest("refusal never retries", [textTurn("I cannot help with that request.")], { calls: 1 })
emptyRecoveryTest("reasoning alone never retries", [[
  LLMEvent.reasoningStart({ id: "r" }), LLMEvent.reasoningDelta({ id: "r", text: "thinking" }),
  LLMEvent.reasoningEnd({ id: "r" }), LLMEvent.finish({ reason: "unknown" }),
]], { calls: 1 })
emptyRecoveryTest("tool input never repeats", [[LLMEvent.toolInputStart({ id: "t", name: "lookup" })]], { calls: 1 })
emptyRecoveryTest("tool call and result never repeat", [[
  LLMEvent.toolCall({ id: "t", name: "lookup", input: {}, providerExecuted: true }),
  LLMEvent.toolResult({ id: "t", name: "lookup", result: { type: "text", value: "done" }, providerExecuted: true }),
]], { calls: 1 })
emptyRecoveryTest("orphan tool result never repeats", [[
  LLMEvent.toolResult({ id: "t", name: "lookup", result: { type: "text", value: "done" }, providerExecuted: true }),
]], { calls: 1 })
emptyRecoveryTest("usage is not empty", [[LLMEvent.finish({ reason: "unknown", usage: { reasoningTokens: 1 } })]], { calls: 1 })
emptyRecoveryTest("explicit stop is not empty", [[LLMEvent.finish({ reason: "stop" })]], { calls: 1 })
emptyRecoveryTest("opaque metadata is not empty", [[LLMEvent.reasoningStart({ id: "r", providerMetadata: { test: { encrypted: "opaque" } } })]], { calls: 1 })
emptyRecoveryTest("cancellation during empty retry backoff", [unfinishedEmpty], { calls: 1, cancel: true })

const retryableProviderFailure = new APICallError({
  message: "scripted provider failure",
  url: "http://localhost:1/v1",
  requestBodyValues: {},
  statusCode: 503,
  isRetryable: true,
  responseHeaders: { "retry-after-ms": "1" },
})
// Provider failures must not replenish the two empty-response retries.
emptyRecoveryTest("interleaved provider failures preserve empty retry budget", [
  unfinishedEmpty,
  retryableProviderFailure,
  [],
  retryableProviderFailure,
  [],
], { calls: 5, exhausted: true })
// Two empty successes must not replenish the five provider-error retries.
emptyRecoveryTest("interleaved empty successes preserve provider retry budget", [
  retryableProviderFailure,
  unfinishedEmpty,
  retryableProviderFailure,
  retryableProviderFailure,
  [],
  retryableProviderFailure,
  retryableProviderFailure,
  retryableProviderFailure,
], { calls: 8, providerExhausted: true })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value.result).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.TextPart => part.type === "text")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for text part",
        )
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = (yield* MessageV2.parts(msg.id)).find((part): part is SessionV1.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value.result).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value.result).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(value.result).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value.result).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value.result).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID === chat.id && data.status.type === "retry") states.push(data.status.attempt)
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        yield* off

        expect(value.result).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value.result).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests complete AI SDK tool calls when native flag is off", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => ({
                title: "Weather lookup",
                output: `result:${input.query}`,
                metadata: { source: "test" },
              }),
            }),
          },
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value.result).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "test" })
        expect(call.state.time.start).toBeDefined()
        expect(call.state.time.end).toBeDefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for tool part",
        )
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== Session.Event.Error.type) return Effect.void
          const data = evt.data as typeof Session.Event.Error.data.Type
          if (data.sessionID !== chat.id || !data.error) return Effect.void
          errs.push(data.error.name)
          seen.resolve()
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        yield* off

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itProviderError.live("session.processor effect tests fail provider-executed error results", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider tool error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "provider tool error" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") expect(call.state.error).toBe("provider boom")
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(MessageV2.Event.Updated.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

itFragmentFailure.live("session.processor effect tests retain partial legacy parts without v2 events", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "provider failure" }],
            tools: {},
          }),
        ).toEqual({ result: "stop", noEditStreak: 0, runaway: false })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        expect(parts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "partial" }),
            expect.objectContaining({ type: "reasoning", text: "thinking" }),
          ]),
        )
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(Session.Event.Error.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

itTextLoop.live("session.processor effect tests detect repeated text loop", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "loop")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "loop" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const textParts = parts.filter((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toEqual({ result: "stop", noEditStreak: 0, runaway: true })
        expect(handle.loopDetected).toBe(true)
        expect(handle.loopReason).toBe("text")
        expect(handle.message.error).toMatchObject({
          name: "MessageAbortedError",
          data: { message: "Runaway text detected — retrying" },
        })
        expect(handle.message.time.completed).toBeDefined()
        expect(textParts.map((part) => part.text)).toEqual(["same", "same", "same"])
        expect(textParts.every((part) => part.time?.end !== undefined)).toBe(true)
        expect(parts.filter((part) => part.type === "step-finish")).toHaveLength(1)
      }),
    { config: cfg },
  ),
)

itNoEdit.instance(
  "session.processor effect tests stop repeated read/search text before no-edit accounting",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { processors, session, provider } = yield* boot()

      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "no edit loop")
      const msg = yield* assistant(chat.id, parent.id, path.resolve(test.directory))
      const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
      const handle = yield* processors.create({
        assistantMessage: msg,
        sessionID: chat.id,
        model: mdl,
      })

      const input = {
        user: {
          id: parent.id,
          sessionID: chat.id,
          role: "user" as const,
          time: parent.time,
          agent: parent.agent,
          model: { providerID: ref.providerID, modelID: ref.modelID },
        } satisfies SessionV1.User,
        sessionID: chat.id,
        model: mdl,
        agent: agent(),
        system: [],
        messages: [{ role: "user" as const, content: "no edit loop" }],
        tools: {},
      }

      // Three consecutive turns that only read/search and never edit.
      pushLLM(textTurn("reading files"))
      pushLLM(textTurn("reading files"))
      pushLLM(textTurn("reading files"))

      expect(yield* handle.process(input)).toEqual({ result: "continue", noEditStreak: 1, runaway: false })
      expect(yield* handle.process(input)).toEqual({ result: "continue", noEditStreak: 2, runaway: false })
      const value = yield* handle.process(input)

      // Repeated text trips runaway before the third no-edit increment.
      expect(value).toEqual({ result: "stop", noEditStreak: 2, runaway: true })
      expect(handle.loopDetected).toBe(true)
      expect(handle.loopReason).toBe("text")
      expect(handle.noEditStreak).toBe(2)
      expect(handle.message.error).toMatchObject({
        name: "MessageAbortedError",
        data: { message: "Runaway text detected — retrying" },
      })
      expect(handle.message.time.completed).toBeDefined()
      const parts = yield* MessageV2.parts(msg.id)
      expect(parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
        "reading files", "reading files", "reading files",
      ])
      expect(parts.filter((part) => part.type === "step-finish")).toHaveLength(3)
    }),
  { config: cfg },
)

const reasoningQueues: LLMEvent[][] = []
function pushReasoningLLM(events: LLMEvent[]) {
  reasoningQueues.push(events)
}
const reasoningLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.fromEffect(
        Effect.sync(() => {
          const q = reasoningQueues.shift() ?? []
          if (q.length) return q
          return [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          ]
        }),
      ).pipe(Stream.flatMap(Stream.fromIterable)),
  }),
)
const reasoningEnv = LayerNode.compile(root, [...replacements, [LLM.node, reasoningLLM]])
const itReasoning = testEffect(reasoningEnv)

let reasoningCallId = 0
function reasoningTurn(text: string): LLMEvent[] {
  reasoningCallId++
  const callId = `call-${reasoningCallId}`
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.reasoningStart({ id: "reasoning-1" }),
    LLMEvent.reasoningDelta({ id: "reasoning-1", text }),
    LLMEvent.reasoningEnd({ id: "reasoning-1" }),
    LLMEvent.toolInputStart({ id: callId, name: "write" }),
    LLMEvent.toolInputEnd({ id: callId, name: "write" }),
    LLMEvent.toolCall({ id: callId, name: "write", input: { path: `a${reasoningCallId}.txt`, content: "x" }, providerExecuted: false }),
    LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ]
}

// Reasoning turn with no tool call at all — the model circles in its head and
// then stops. This is the case the original per-turn array detector missed.
function reasoningOnlyTurn(text: string): LLMEvent[] {
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.reasoningStart({ id: "reasoning-1" }),
    LLMEvent.reasoningDelta({ id: "reasoning-1", text }),
    LLMEvent.reasoningEnd({ id: "reasoning-1" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ]
}

// A provider-executed tool that completes with a real result. Unlike
// `toolTurn` (which leaves the call pending), this sets `stateChanged` so the
// cross-turn streak detectors reset on real progress.
function providerToolTurn(name: string, input: Record<string, unknown>): LLMEvent[] {
  providerCallId++
  const id = `call-${providerCallId}`
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id, name }),
    LLMEvent.toolInputEnd({ id, name }),
    LLMEvent.toolCall({ id, name, input, providerExecuted: true }),
    LLMEvent.toolResult({
      id,
      name,
      result: { type: "json", value: { ok: true } },
      providerExecuted: true,
    }),
    LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ]
}

let providerCallId = 0

itReasoning.live(
  "session.processor effect tests detect repeated reasoning loop",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "reasoning loop")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const input = {
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user" as const,
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user" as const, content: "reasoning loop" }],
            tools: {},
          }

          pushReasoningLLM(reasoningTurn("circling the same thought"))
          pushReasoningLLM(reasoningTurn("circling the same thought"))
          pushReasoningLLM(reasoningTurn("circling the same thought"))

          expect(yield* handle.process(input)).toEqual({ result: "continue", noEditStreak: 1, runaway: false })
          expect(yield* handle.process(input)).toEqual({ result: "continue", noEditStreak: 2, runaway: false })
          const value = yield* handle.process(input)

          expect(value).toEqual({ result: "stop", noEditStreak: 2, runaway: true })
          expect(handle.loopDetected).toBe(true)
          expect(handle.loopReason).toBe("reasoning")
          expect(handle.message.error).toMatchObject({
            name: "MessageAbortedError",
            data: { message: "Runaway reasoning detected — retrying" },
          })
          expect(handle.message.time.completed).toBeDefined()
          const parts = yield* MessageV2.parts(msg.id)
          expect(parts.filter((part) => part.type === "reasoning").map((part) => part.text)).toEqual([
            "circling the same thought", "circling the same thought", "circling the same thought",
          ])
          expect(parts.filter((part) => part.type === "step-finish")).toHaveLength(3)
          const tools = parts.filter((part) => part.type === "tool")
          expect(tools).toHaveLength(3)
          expect(tools.every((part) => part.tool === "write" && part.state.status === "error")).toBe(true)
        }),
      { config: cfg },
    ),
)

itReasoning.live(
  "session.processor effect tests reset reasoning history after a distinct turn",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "reasoning reset")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const input = {
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user" as const,
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user" as const, content: "reasoning reset" }],
            tools: {},
          }

          pushReasoningLLM(reasoningTurn("first thought"))
          pushReasoningLLM(reasoningTurn("second thought"))
          pushReasoningLLM(reasoningTurn("third thought"))

          yield* handle.process(input)
          yield* handle.process(input)
          const value = yield* handle.process(input)

          expect(value.result).toBe("continue")
          expect(handle.loopReason).not.toBe("reasoning")
        }),
      { config: cfg },
    ),
)

itNoEdit.instance(
  "session.processor effect tests do not treat an uncompleted edit attempt as progress",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { processors, session, provider } = yield* boot()

      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "edit resets streak")
      const msg = yield* assistant(chat.id, parent.id, path.resolve(test.directory))
      const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
      const handle = yield* processors.create({
        assistantMessage: msg,
        sessionID: chat.id,
        model: mdl,
      })

      const input = {
        user: {
          id: parent.id,
          sessionID: chat.id,
          role: "user" as const,
          time: parent.time,
          agent: parent.agent,
          model: { providerID: ref.providerID, modelID: ref.modelID },
        } satisfies SessionV1.User,
        sessionID: chat.id,
        model: mdl,
        agent: agent(),
        system: [],
        messages: [{ role: "user" as const, content: "edit resets streak" }],
        tools: {},
      }

      // Two read-only turns, then an uncompleted edit. No patch was observed.
      pushLLM(textTurn("reading files"))
      pushLLM(textTurn("reading more"))
      pushLLM(toolTurn("write", { path: "a.txt", content: "x" }))

      yield* handle.process(input)
      yield* handle.process(input)
      const value = yield* handle.process(input)

      expect(value.result).toBe("continue")
      expect(handle.loopDetected).toBe(false)
      expect(handle.noEditStreak).toBe(3)
    }),
  { config: cfg },
)

itReasoning.live(
  "session.processor effect tests detect repeated reasoning loop with no tool call",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "reasoning only loop")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const input = {
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user" as const,
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user" as const, content: "reasoning only loop" }],
            tools: {},
          }

          pushReasoningLLM(reasoningOnlyTurn("circling the same thought"))
          pushReasoningLLM(reasoningOnlyTurn("circling the same thought"))
          pushReasoningLLM(reasoningOnlyTurn("circling the same thought"))

          expect(yield* handle.process(input)).toEqual({ result: "continue", noEditStreak: 1, runaway: false })
          expect(yield* handle.process(input)).toEqual({ result: "continue", noEditStreak: 2, runaway: false })
          const value = yield* handle.process(input)

          // The error return precedes no-edit accounting for this turn.
          expect(value).toEqual({ result: "stop", noEditStreak: 2, runaway: true })
          expect(handle.loopDetected).toBe(true)
          expect(handle.loopReason).toBe("reasoning")
          expect(handle.noEditStreak).toBe(2)
          expect(handle.message.error).toMatchObject({
            name: "MessageAbortedError",
            data: { message: "Runaway reasoning detected — retrying" },
          })
          expect(handle.message.time.completed).toBeDefined()
          const parts = yield* MessageV2.parts(msg.id)
          expect(parts.filter((part) => part.type === "reasoning").map((part) => part.text)).toEqual([
            "circling the same thought", "circling the same thought", "circling the same thought",
          ])
          expect(parts.filter((part) => part.type === "step-finish")).toHaveLength(3)
          expect(parts.filter((part) => part.type === "tool")).toEqual([])
        }),
      { config: cfg },
    ),
)

itNoEdit.instance(
  "session.processor effect tests detect alternating text across turns",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "alternating text")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const input = {
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user" as const,
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user" as const, content: "alternating text" }],
            tools: {},
          }

          // A → B → A → B → A → B — never three consecutive identicals, so
          // the text/reasoning streak detectors miss it. Only the new
          // alternation detector should fire.
          pushLLM(textTurn("option one"))
          pushLLM(textTurn("option two"))
          pushLLM(textTurn("option one"))
          pushLLM(textTurn("option two"))
          pushLLM(textTurn("option one"))
          pushLLM(textTurn("option two"))

          yield* handle.process(input)
          yield* handle.process(input)
          // Lack of edits is not itself a loop. A/B/A has not yet repeated B.
          expect(yield* handle.process(input)).toEqual({ result: "continue", noEditStreak: 3, runaway: false })
          expect(handle.loopDetected).toBe(false)
          expect(handle.loopReason).toBe("none")
          expect(handle.noEditStreak).toBe(3)
          expect(handle.message.error).toBeUndefined()
          yield* handle.process(input)
          yield* handle.process(input)
          const value = yield* handle.process(input)

          expect(value.result).toBe("continue")
          expect(handle.loopDetected).toBe(true)
          expect(handle.loopReason).toBe("alternation")
        }),
      { config: cfg },
    ),
)

itNoEdit.instance(
  "session.processor effect tests reset text/reasoning streaks on state-changing tool result",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { processors, session, provider } = yield* boot()

      const chat = yield* session.create({})
      const parent = yield* user(chat.id, "reset on progress")
      const msg = yield* assistant(chat.id, parent.id, path.resolve(test.directory))
      const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
      const handle = yield* processors.create({
        assistantMessage: msg,
        sessionID: chat.id,
        model: mdl,
      })

      const input = {
        user: {
          id: parent.id,
          sessionID: chat.id,
          role: "user" as const,
          time: parent.time,
          agent: parent.agent,
          model: { providerID: ref.providerID, modelID: ref.modelID },
        } satisfies SessionV1.User,
        sessionID: chat.id,
        model: mdl,
        agent: agent(),
        system: [],
        messages: [{ role: "user" as const, content: "reset on progress" }],
        tools: {},
      }

      // Two identical text turns, then a state-changing edit. The text streak
      // should reset, and the edit also clears the no-edit streak.
      pushLLM(textTurn("reading files"))
      pushLLM(textTurn("reading files"))
      pushLLM(providerToolTurn("write", { path: "a.txt", content: "x" }))

      yield* handle.process(input)
      yield* handle.process(input)
      const value = yield* handle.process(input)

      expect(value.result).toBe("continue")
      expect(handle.loopDetected).toBe(false)
    }),
  { config: cfg },
)
