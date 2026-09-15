// ──────────────────────────────────────────────────────────────
// Shared fixture for session-runner test files
// ──────────────────────────────────────────────────────────────

import { expect } from "bun:test"
import { LLMClient, Model, type LLMClientShape } from "@opencode-ai/llm"
import type { LLMRequest } from "@opencode-ai/llm"
export type { LLMRequest }
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Database } from "@opencode-ai/core/database/database"
export { Database }
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { EventTable } from "@opencode-ai/core/event/sql"
export { EventTable }
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
export { AbsolutePath }
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
export { ApplicationTools }
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { SessionContextEpochTable, SessionTable } from "@opencode-ai/core/session/sql"
export { SessionContextEpochTable, SessionTable }
import { SessionInputTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { Location } from "@opencode-ai/core/location"
export { Location }
import { eq, asc } from "drizzle-orm"
export { eq, asc }
import { testEffect } from "./lib/effect"

// ── Re-exports for test files ─────────────────────────────────

import { LLMError, LLMEvent, TransportReason, InvalidRequestReason } from "@opencode-ai/llm"
export { LLMError, LLMEvent, TransportReason, InvalidRequestReason }
import { EventV2 } from "@opencode-ai/core/event"
export { EventV2 }
import { QuestionV2 } from "@opencode-ai/core/question"
export { QuestionV2 }
import { SessionV2 } from "@opencode-ai/core/session"
export { SessionV2 }
import { ContextSnapshotDecodeError } from "@opencode-ai/core/session/error"
export { ContextSnapshotDecodeError }
import { SessionEvent } from "@opencode-ai/core/session/event"
export { SessionEvent }
import { SessionInput } from "@opencode-ai/core/session/input"
export { SessionInput }
import { SessionMessage } from "@opencode-ai/core/session/message"
export { SessionMessage }
import { Prompt } from "@opencode-ai/core/session/prompt"
export { Prompt }
import { SessionRunner } from "@opencode-ai/core/session/runner"
export { SessionRunner }
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
export { ToolRegistry }
import { AgentV2 } from "@opencode-ai/core/agent"
export { AgentV2 }
import { Tool } from "@opencode-ai/core/tool/tool"
export { Tool }
import { SessionStore } from "@opencode-ai/core/session/store"
export { SessionStore }
import { SystemContext } from "@opencode-ai/core/system-context"
export { SystemContext }
import { ModelV2 } from "@opencode-ai/core/model"
export { ModelV2 }
import { ProviderV2 } from "@opencode-ai/core/provider"
export { ProviderV2 }
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
export { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream }

// ── Mutable test state ───────────────────────────────────────
// Using a state object so test files can mutate properties
// (named imports are read-only bindings in ES modules)

export const State = {
  requests: [] as LLMRequest[],
  response: [] as LLMEvent[],
  responses: undefined as LLMEvent[][] | undefined,
  responseStream: undefined as Stream.Stream<LLMEvent, LLMError> | undefined,
  streamGate: undefined as Deferred.Deferred<void> | undefined,
  streamStarted: undefined as Deferred.Deferred<void> | undefined,
  streamFailure: undefined as LLMError | undefined,
  toolExecutionGate: undefined as Deferred.Deferred<void> | undefined,
  toolExecutionsStarted: undefined as Deferred.Deferred<void> | undefined,
  toolExecutionsReady: 5,
  activeToolExecutions: 0,
  maxActiveToolExecutions: 0,
  modelResolveHook: Effect.void,
  currentModel: null as unknown as typeof model,
  currentModelInfo: null as unknown as typeof modelInfo,
  systemBaseline: "Initial context",
  systemRemoved: false,
  systemUnavailable: false,
  systemLoadHook: Effect.void,
  authorizations: [] as Tool.Context[],
  executions: [] as string[],
  skillBaselines: new Map<AgentV2.ID, string>(),
}

// ── Mock layers ──────────────────────────────────────────────

export const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      State.requests.push(request)
      if (State.responseStream) {
        const stream = State.responseStream
        State.responseStream = undefined
        return stream
      }
      const events = State.streamFailure
        ? Stream.fail(State.streamFailure)
        : Stream.fromIterable(State.responses === undefined ? State.response : (State.responses.shift() ?? []))
      if (!State.streamGate) return events
      return Stream.unwrap(
        (State.streamStarted ? Deferred.succeed(State.streamStarted, undefined) : Effect.void).pipe(
          Effect.andThen(Deferred.await(State.streamGate)),
          Effect.as(events),
        ),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

export const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
export const replacementModel = Model.make({ id: "replacement", provider: "fake", route: OpenAIChat.route })
export const compactModel = Model.make({
  id: "compact",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 4_000, output: 50 } }),
})
export const recoveryModel = Model.make({
  id: "recovery",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 20_000, output: 1_000 } }),
})

export const modelInfo = ModelV2.Info.make({
  id: ModelV2.ID.make("fake-model"),
  providerID: ProviderV2.ID.make("fake"),
  name: "Fake Model",
  api: { id: ModelV2.ID.make("fake-model"), type: "native", settings: {} },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: { headers: {}, body: {} },
  variants: [],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 100_000, output: 100_000 },
})

export const replacementModelInfo = ModelV2.Info.make({
  id: ModelV2.ID.make("replacement"),
  providerID: ProviderV2.ID.make("fake"),
  name: "Replacement Model",
  api: { id: ModelV2.ID.make("replacement"), type: "native", settings: {} },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: { headers: {}, body: {} },
  variants: [],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 100_000, output: 100_000 },
})

export const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

export const echo = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      echo: Tool.make({
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }, context) =>
          Effect.gen(function* () {
            State.authorizations.push(context)
            State.executions.push(text)
            State.activeToolExecutions++
            State.maxActiveToolExecutions = Math.max(State.maxActiveToolExecutions, State.activeToolExecutions)
            if (State.activeToolExecutions === State.toolExecutionsReady && State.toolExecutionsStarted) {
              yield* Deferred.succeed(State.toolExecutionsStarted, undefined)
            }
            if (State.toolExecutionGate) yield* Deferred.await(State.toolExecutionGate)
            return { text }
          }).pipe(Effect.ensuring(Effect.sync(() => State.activeToolExecutions--))),
      }),
      defect: Tool.make({
        description: "Fail unexpectedly",
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        execute: () => Effect.die("unexpected tool defect"),
      }),
    }),
  ),
)

export const echoNode = makeLocationNode({ name: "test/session-runner-tools", layer: echo, deps: [ToolRegistry.node] })

export const models = SessionRunnerModel.layerWith(
  (session) =>
    State.modelResolveHook.pipe(
      Effect.as(session.model?.id === "replacement" ? replacementModel : State.currentModel ?? model),
    ),
  (session) =>
    Effect.succeed(
      session.model?.id === "replacement" ? replacementModelInfo : State.currentModelInfo ?? modelInfo,
    ),
)

export const systemContextKey = SystemContext.Key.make("test/context")
export const skillBaselines = new Map<AgentV2.ID, string>()

export const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: systemContextKey,
        load: Effect.sync(() =>
          SystemContext.combine(
            State.systemRemoved
              ? []
              : [
                  SystemContext.make({
                    key: systemContextKey,
                    codec: Schema.toCodecJson(Schema.String),
                    load: State.systemLoadHook.pipe(
                      Effect.andThen(
                        Effect.sync(() => (State.systemUnavailable ? SystemContext.unavailable : State.systemBaseline)),
                      ),
                    ),
                    baseline: String,
                    update: (_previous, current) => current,
                    removed: () => "System context source removed: test/context",
                  }),
                ],
          ),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(AppNodeBuilder.build(SystemContextRegistry.node)))

export const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: (agent) =>
    Effect.succeed(
      State.skillBaselines.has(agent.id)
        ? SystemContext.make({
            key: SystemContext.Key.make("test/skill-guidance"),
            codec: Schema.toCodecJson(Schema.String),
            load: Effect.succeed(State.skillBaselines.get(agent.id)!),
            baseline: String,
            update: (_previous, current) => current,
            removed: () => "Skill guidance removed",
          })
        : SystemContext.empty,
    ),
})

export const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })

export const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  }),
)

export const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [PermissionV2.node, permission],
  [Config.node, config],
])

export const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))

export const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      QuestionV2.node,
      SessionProjector.node,
      SessionStore.node,
      ApplicationTools.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      echoNode,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
    ],
  ),
)

export const sessionID = SessionV2.ID.make("ses_runner_test")
export const otherSessionID = SessionV2.ID.make("ses_runner_other")

export const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

export const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  State.response = []
  State.systemBaseline = "Initial context"
  State.systemRemoved = false
  State.systemUnavailable = false
  State.systemLoadHook = Effect.void
  State.modelResolveHook = Effect.void
  State.currentModel = model
  State.currentModelInfo = modelInfo
  State.skillBaselines.clear()
  State.responses = undefined
  State.streamFailure = undefined
  State.responseStream = undefined
  State.streamGate = undefined
  State.streamStarted = undefined
  State.toolExecutionGate = undefined
  State.toolExecutionsStarted = undefined
  State.toolExecutionsReady = 5
  State.activeToolExecutions = 0
  State.maxActiveToolExecutions = 0
  State.requests.length = 0
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .delete(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
  yield* db
    .delete(SessionInputTable)
    .where(eq(SessionInputTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
  yield* db
    .delete(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
  yield* db
    .delete(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
})

export const providerUnavailable = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message: "Provider unavailable" }),
  })

export const setupOverflowRecovery = Effect.gen(function* () {
  yield* setup
  const session = yield* SessionV2.Service
  State.response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
  yield* session.prompt({
    sessionID,
    prompt: Prompt.make({ text: "Earlier question ".repeat(700) }),
    resume: false,
  })
  yield* session.resume(sessionID)
  State.currentModel = recoveryModel
  State.requests.length = 0
  return session
})

const messageTexts = (request: LLMRequest, role: "user" | "system") =>
  request.messages.flatMap((message) =>
    message.role === role ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : [],
  )
export const userTexts = (request: LLMRequest) => messageTexts(request, "user")
export const systemTexts = (request: LLMRequest) => messageTexts(request, "system")

export const replaySessionProjection = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const recorded = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)

    yield* events.remove(id)
    yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, id)).run().pipe(Effect.orDie)
    yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, id)).run().pipe(Effect.orDie)
    yield* events.replayAll(
      recorded.map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })),
    )
  })

export type FragmentKind = "text" | "reasoning" | "tool input"

export type FragmentFixture = {
  readonly delta: EventV2.Definition
  readonly completeEvents: LLMEvent[]
  readonly partialEvents: LLMEvent[]
  readonly expectedAssistant: unknown
  readonly expectedContent: unknown
}

export const fragmentKinds: readonly FragmentKind[] = ["text", "reasoning", "tool input"]

const fragmentID = (kind: FragmentKind, suffix: string) => `${kind === "tool input" ? "call" : kind}-${suffix}`

export const fragmentFixture = (kind: FragmentKind, id: string, chunks: readonly string[]): FragmentFixture => {
  const text = chunks.join("")
  switch (kind) {
    case "text": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        ...chunks.map((text) => LLMEvent.textDelta({ id, text })),
      ]
      const expectedContent = { type: "text", id, text }
      return {
        delta: SessionEvent.Text.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.textEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "reasoning": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id }),
        ...chunks.map((text) => LLMEvent.reasoningDelta({ id, text })),
      ]
      const expectedContent = { type: "reasoning", id, text }
      return {
        delta: SessionEvent.Reasoning.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.reasoningEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "tool input": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "echo" }),
        ...chunks.map((text) => LLMEvent.toolInputDelta({ id, name: "echo", text })),
      ]
      const expectedContent = { type: "tool", id, state: { status: "pending", input: text } }
      return {
        delta: SessionEvent.Tool.Input.Delta,
        partialEvents,
        completeEvents: [...partialEvents, LLMEvent.toolInputEnd({ id, name: "echo" })],
        expectedAssistant: { type: "assistant", content: [expectedContent] },
        expectedContent,
      }
    }
  }
}

export const verifyEphemeralDeltas = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Stream ${kind}`
    const chunks = Array.from({ length: 32 }, (_, index) => `${index},`)
    const fixture = fragmentFixture(kind, fragmentID(kind, "many"), chunks)
    const expectedContext = [{ type: "user", text: prompt }, fixture.expectedAssistant]
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    const events = yield* EventV2.Service
    const live = yield* events.subscribe(fixture.delta).pipe(Stream.take(32), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    State.response = fixture.completeEvents

    yield* session.resume(sessionID)

    const { db } = yield* Database.Service
    const deltas = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.type, EventV2.versionedType(fixture.delta.type, 1)))
      .all()
      .pipe(Effect.orDie)
    expect(Array.from(yield* Fiber.join(live))).toHaveLength(32)
    expect(deltas).toHaveLength(0)
    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)

    yield* replaySessionProjection(sessionID)

    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)
  })

export const verifyPartialFlushOnFailure = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Fail after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "partial"), ["Partial"])
    const failure = providerUnavailable()
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    State.responseStream = Stream.concat(Stream.fromIterable(fixture.partialEvents), Stream.fail(failure))

    expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider unavailable" },
        content: [fixture.expectedContent],
      },
    ])
  })

export const verifyPartialFlushOnInterruption = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Interrupt after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "interrupted"), ["Partial"])
    const streamed = yield* Deferred.make<void>()
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    State.responseStream = Stream.concat(
      Stream.fromIterable(fixture.partialEvents),
      Stream.fromEffect(Deferred.succeed(streamed, undefined)).pipe(Stream.flatMap(() => Stream.never)),
    )

    const runner = yield* SessionRunner.Service
    const fiber = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
    yield* Deferred.await(streamed)
    yield* Fiber.interrupt(fiber)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider turn interrupted" },
        content: [
          kind === "tool input"
            ? { type: "tool", id: fragmentID(kind, "interrupted"), state: { status: "error" } }
            : fixture.expectedContent,
        ],
      },
    ])
  })
