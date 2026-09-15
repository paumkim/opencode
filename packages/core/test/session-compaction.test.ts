import { describe, expect } from "bun:test"
import {
  it,
  setup,
  setupOverflowRecovery,
  sessionID,
  compactModel,
  recoveryModel,
  replaySessionProjection,
  LLMError,
  LLMEvent,
  InvalidRequestReason,
  Effect,
  Stream,
  Deferred,
  Fiber,
  DateTime,
  EventV2,
  Prompt,
  SessionV2,
  SessionRunner,
  Database,
  SessionMessage,
  SessionInput,
  SessionStore,
  SessionEvent,
  fragmentFixture,
  userTexts,
  systemTexts,
  State,
} from "./session-runner.fixture"

describe("SessionRunnerLLM", () => {
  it.effect("rebuilds the baseline directly after completed compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      State.requests.length = 0
      State.response = []
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      State.systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(State.requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context"],
        ["Replacement context"],
      ])
      yield* replaySessionProjection(sessionID)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("automatically compacts into a completed summary and retained recent turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      State.response = fragmentFixture("text", "text-first", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Earlier question ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      State.currentModel = compactModel
      State.requests.length = 0
      State.responses = [
        fragmentFixture("text", "text-summary", ["## Objective\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recent exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(State.requests).toHaveLength(2)
      expect(userTexts(State.requests[0])[0]).toContain("## Objective")
      expect(userTexts(State.requests[1])).toHaveLength(1)
      expect(userTexts(State.requests[1])[0]).toContain("<summary>\n## Objective\n- Preserve the task\n</summary>")
      expect(userTexts(State.requests[1])[0]).toContain(`[User]: ${"Recent exact request ".repeat(180)}`)

      const context = yield* (yield* SessionStore.Service).context(sessionID)
      expect(context.map((message) => message.type)).toEqual(["compaction", "assistant"])
      expect(context[0]).toMatchObject({
        type: "compaction",
        summary: "## Objective\n- Preserve the task",
      })

      State.requests.length = 0
      State.executions.length = 0
      State.responses = [
        fragmentFixture("text", "text-summary-2", ["## Objective\n- Preserve the updated task"]).completeEvents,
        fragmentFixture("text", "text-final-2", ["Continued again"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Newest exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(State.requests).toHaveLength(2)
      expect(userTexts(State.requests[0])[0]).toContain(
        "<prior-summary>\n## Objective\n- Preserve the task\n</prior-summary>",
      )
      expect(userTexts(State.requests[0])[0]).toContain("Recent exact request")
      expect((yield* (yield* SessionStore.Service).context(sessionID))[0]).toMatchObject({
        type: "compaction",
        summary: "## Objective\n- Preserve the updated task",
      })
    }),
  )

  it.effect("forces one compaction and retries after provider context overflow", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      State.responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ],
        fragmentFixture("text", "text-summary", ["## Objective\n- Recover overflow"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(State.requests).toHaveLength(3)
      expect(userTexts(State.requests[1])[0]).toContain("## Objective")
      expect(userTexts(State.requests[2])[0]).toContain("<summary>\n## Objective\n- Recover overflow\n</summary>")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Objective\n- Recover overflow" },
        { type: "assistant", finish: "stop" },
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("persists a second context overflow after one recovery", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const overflow = () => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      State.responses = [
        overflow(),
        fragmentFixture("text", "text-summary", ["## Objective\n- Recover once"]).completeEvents,
        overflow(),
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(State.requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  it.effect("recovers once from a raw context overflow failure", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      State.responseStream = Stream.fail(
        new LLMError({
          module: "test",
          method: "stream",
          reason: new InvalidRequestReason({
            message: "prompt too long",
            classification: "context-overflow",
          }),
        }),
      )
      State.responses = [
        fragmentFixture("text", "text-summary", ["## Objective\n- Recover raw overflow"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(State.requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Objective\n- Recover raw overflow" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("publishes the original overflow when recovery summarization fails", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      State.responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        [LLMEvent.providerError({ message: "summary unavailable" })],
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(State.requests).toHaveLength(2)
      const context = yield* session.context(sessionID)
      expect(context.some((message) => message.type === "compaction")).toBe(false)
      expect(context.slice(-2)).toMatchObject([
        { type: "user", text: "Continue" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  it.effect("interrupts overflow recovery while the summary provider is running", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      State.responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        fragmentFixture("text", "text-summary", ["## Objective\n- Interrupted"]).completeEvents,
      ]
      const firstGate = yield* Deferred.make<void>()
      const summaryGate = yield* Deferred.make<void>()
      State.streamGate = firstGate
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (State.requests.length < 1) yield* Effect.yieldNow
      State.streamGate = summaryGate
      yield* Deferred.succeed(firstGate, undefined)
      while (State.requests.length < 2) yield* Effect.yieldNow

      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      State.streamGate = undefined
      expect(State.requests).toHaveLength(2)
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  it.effect("preserves effective System updates while compaction rebaseline is blocked", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      State.requests.length = 0
      State.response = []
      yield* session.resume(sessionID)
      State.systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      State.systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(State.requests.at(-1)?.system.map((part) => part.text)).toEqual([
        `Initial context`,
      ])
      expect(systemTexts(State.requests.at(-1)!)).toContain("Changed context")
    }),
  )
})
