import { describe, expect } from "bun:test"
import {
  it,
  setup,
  sessionID,
  model,
  replaySessionProjection,
  fragmentFixture,
  LLMEvent,
  Effect,
  DateTime,
  EventV2,
  Database,
  Prompt,
  SessionV2,
  AgentV2,
  SessionMessage,
  SessionInput,
  SessionStore,
  ModelV2,
  ProviderV2,
  SystemContext,
  SessionEvent,
  SessionContextEpochTable,
  SessionTable,
  EventTable,
  eq,
  userTexts,
  systemTexts,
  State,
} from "./session-runner.fixture"

describe("SessionRunnerLLM", () => {
  it.effect("reuses one durable baseline after the context producer changes", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      State.requests.length = 0
      State.response = []
      yield* session.resume(sessionID)
      State.systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(State.requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [
          `Initial context`,
        ],
        [
          `Initial context`,
        ],
      ])
      expect(State.requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(State.requests[1]?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Changed context" }])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, "session.next.context.updated.1"))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("includes the effective default agent system before durable context", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      State.requests.length = 0
      State.response = fragmentFixture("text", "text-build", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(State.requests.at(-1)?.system.map((part) => part.text)).toEqual([
        "Build agent instructions",
        `Initial context`,
      ])
    }),
  )

  it.effect("uses the configured default agent system for omitted-agent sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) => {
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        })
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        })
        editor.default(AgentV2.ID.make("reviewer"))
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      State.requests.length = 0
      State.response = fragmentFixture("text", "text-reviewer", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(State.requests.at(-1)?.system.map((part) => part.text)).toEqual([
        "Reviewer instructions",
        `Initial context`,
      ])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("uses an explicitly selected non-build agent system", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        }),
      )
      yield* db
        .update(SessionTable)
        .set({ agent: "reviewer" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      State.requests.length = 0
      State.response = fragmentFixture("text", "text-selected", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(State.requests.at(-1)?.system.map((part) => part.text)).toEqual([
        "Reviewer instructions",
        `Initial context`,
      ])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("updates selected-agent skill guidance after an agent switch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      State.skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      State.requests.length = 0
      State.response = []
      yield* session.resume(sessionID)
      State.skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        agent: "reviewer",
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(State.requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [
          `Initial context

Build skills`,
        ],
        [
          `Initial context

Build skills`,
        ],
      ])
    }),
  )

  it.effect("keeps the sampled agent when selection changes during observation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      State.skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      State.skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      State.systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            agent: "reviewer",
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      State.requests.length = 0
      State.response = []
      yield* session.resume(sessionID)

      expect(State.requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [
          `Initial context

Build skills`,
        ],
      ])
    }),
  )

  it.effect("keeps the sampled model when selection changes during model resolution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      let switched = false
      State.modelResolveHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.ModelSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      State.requests.length = 0
      State.response = []
      yield* session.resume(sessionID)
      expect(State.requests.map((request) => request.model)).toEqual([model])
      expect(State.requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [
          `Initial context`,
        ],
      ])
    }),
  )

  it.effect("admits removed context as a chronological System message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      State.requests.length = 0
      State.response = []
      yield* session.resume(sessionID)
      State.systemRemoved = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(State.requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(State.requests[1]?.messages.at(-1)?.content).toEqual([
        { type: "text", text: "System context source removed: test/context" },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("keeps the baseline and chronological System updates after a model switch", () =>
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
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      State.systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(State.requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [
          `Initial context`,
        ],
        [
          `Initial context`,
        ],
        [
          `Initial context`,
        ],
      ])
      expect(State.requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(State.requests[2]?.messages.filter((message) => message.role === "system")).toHaveLength(2)
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "user",
        "system",
        "model-switched",
        "user",
        "system",
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(6)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fourth" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("preserves the baseline while context is temporarily unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      State.requests.length = 0
      State.response = []
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      State.systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      State.systemUnavailable = false
      State.systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(State.requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [
          `Initial context`,
        ],
        [
          `Initial context`,
        ],
        [
          `Initial context`,
        ],
      ])
    }),
  )
})
