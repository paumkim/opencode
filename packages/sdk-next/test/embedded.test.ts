import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Deferred, Effect, Latch, Option, Schedule, Schema, Stream } from "effect"
import type { OpenCodeEvent } from "../src"
import type { create as createOpenCode } from "../src/opencode"

const sharedDirectory = join(tmpdir(), `opencode-embedded-suite-${crypto.randomUUID()}`)
const providerBaseURL = "https://embedded-provider.test/v1"
const originalDatabase = Flag.OPENCODE_DB
const originalConfigContent = Flag.OPENCODE_CONFIG_CONTENT
const originalFetch = globalThis.fetch

mkdirSync(sharedDirectory, { recursive: true })
Flag.OPENCODE_DB = ":memory:"

const location = (name: string) => {
  const directory = join(sharedDirectory, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, "opencode.json"),
    JSON.stringify({
      model: "test/embedded",
      providers: {
        test: {
          api: { type: "aisdk", package: "@ai-sdk/openai", url: providerBaseURL },
          request: { headers: {}, body: {} },
          models: {
            embedded: {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 128000, output: 4096 },
              api: { type: "aisdk", package: "@ai-sdk/openai" },
            },
          },
        },
      },
    }),
  )
  return directory
}

const providerSSE = (body: string) =>
  new Response(
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", delta: body })}\n\n` +
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_embedded" } })}\n\n` +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )

const waitForLocation = (opencode: Effect.Success<ReturnType<typeof createOpenCode>>, directory: string) =>
  Effect.gen(function* () {
    yield* opencode.models
      .list({ location: { directory } })
      .pipe(
        Effect.repeat({
          schedule: Schedule.spaced("25 millis"),
          while: (models) => !models.data.some((model) => model.id === "embedded" && model.providerID === "test"),
        }),
        Effect.timeout("4 seconds"),
        Effect.orDie,
      )
  })

beforeAll(() => {
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    if (request.url.startsWith(providerBaseURL)) return providerSSE("Done.")
    return originalFetch(input, init)
  }) as typeof globalThis.fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
  Flag.OPENCODE_DB = originalDatabase
  Flag.OPENCODE_CONFIG_CONTENT = originalConfigContent
  rmSync(sharedDirectory, { recursive: true, force: true })
})

test("embedded client uses the real router and handlers", async () => {
  const directory = location("router")
  const { AbsolutePath, Agent, Location, Model, OpenCode, Prompt, Provider, Session, Tool } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)
  const model = Model.Ref.make({ id: Model.ID.make("embedded"), providerID: Provider.ID.make("test") })

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const opencode = yield* OpenCode.create()
        yield* opencode.tools.register({
          embedded_tool: Tool.make({
            description: "Embedded test tool",
            input: Schema.Struct({}),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: () => Effect.succeed({ ok: true }),
          }),
        })

        const created = yield* opencode.sessions.create({
          id: sessionID,
          agent: Agent.ID.make("build"),
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })
        yield* opencode.sessions.switchModel({ sessionID, model })
        const selected = yield* opencode.sessions.get({ sessionID })
        const page = yield* opencode.sessions.list({ directory: AbsolutePath.make(directory) })
        const active = yield* opencode.sessions.active()
        const admitted = yield* opencode.sessions.prompt({
          sessionID,
          prompt: Prompt.make({ text: "Do not run" }),
          resume: false,
        })
        const context = yield* opencode.sessions.context({ sessionID })
        const event = yield* opencode.sessions
          .events({ sessionID })
          .pipe(Stream.take(1), Stream.runHead, Effect.map(Option.getOrUndefined))
        const modelMessage = Option.fromNullishOr(context.find((message) => message.type === "model-switched")).pipe(
          Option.getOrThrow,
        )
        const message = yield* opencode.sessions.message({ sessionID, messageID: modelMessage.id })
        yield* opencode.sessions.interrupt({ sessionID })
        const other = yield* opencode.sessions.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })
        const missingSessionID = Session.ID.make(`ses_missing_${crypto.randomUUID()}`)
        const missing = yield* Effect.all(
          [
            opencode.sessions.events({ sessionID: missingSessionID }).pipe(Stream.runHead, Effect.flip),
            opencode.sessions.interrupt({ sessionID: missingSessionID }).pipe(Effect.flip),
            opencode.sessions.message({ sessionID: missingSessionID, messageID: modelMessage.id }).pipe(Effect.flip),
          ],
          { concurrency: "unbounded" },
        )
        const missingMessage = yield* Effect.flip(
          opencode.sessions.message({ sessionID: other.id, messageID: modelMessage.id }),
        )

        expect(created.id).toBe(sessionID)
        expect(selected.model?.id).toBe(model.id)
        expect(selected.model?.providerID).toBe(model.providerID)
        expect(page.data.some((session) => session.id === sessionID)).toBe(true)
        expect(active).toEqual({})
        expect(admitted.sessionID).toBe(sessionID)
        expect(context.some((message) => message.type === "model-switched")).toBe(true)
        expect(event).toMatchObject({ type: "session.next.model.switched", durable: { seq: 1 } })
        expect(message).toEqual(modelMessage)
        expect(missing.map((error) => error._tag)).toEqual([
          "SessionNotFoundError",
          "SessionNotFoundError",
          "SessionNotFoundError",
        ])
        expect(missingMessage._tag).toBe("MessageNotFoundError")
      }),
    ),
  )
}, 30_000)

test("Location-owned runner events reach the ready global client", async () => {
  const directory = location("runner-events")
  const { AbsolutePath, Location, OpenCode, Prompt, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const opencode = yield* OpenCode.create()
        yield* waitForLocation(opencode, directory)
        const connected = yield* Latch.make(false)
        const prompted = yield* Deferred.make<OpenCodeEvent>()
        yield* opencode.events.subscribe().pipe(
          Stream.runForEach((event) =>
            event.type === "server.connected"
              ? connected.open
              : event.type === "session.next.prompted" && event.data.sessionID === sessionID
                ? Deferred.succeed(prompted, event).pipe(Effect.asVoid)
                : Effect.void,
          ),
          Effect.forkScoped,
        )
        yield* connected.await
        yield* opencode.sessions.create({
          id: sessionID,
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })
        yield* opencode.sessions.prompt({ sessionID, prompt: Prompt.make({ text: "Observe this input" }) })

        const event = yield* Deferred.await(prompted).pipe(Effect.timeout("4 seconds"))
        expect(event.durable).toEqual(expect.objectContaining({ aggregateID: sessionID, seq: expect.any(Number) }))
      }),
    ),
  )
}, 30_000)

test("independent embedded hosts do not share live notifications", async () => {
  const directory = location("independent-hosts")
  const { AbsolutePath, Agent, Location, OpenCode, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* OpenCode.create()
        const second = yield* OpenCode.create()
        const firstReady = yield* Latch.make(false)
        const secondReady = yield* Latch.make(false)
        const firstEvent = yield* Latch.make(false)
        const secondEvent = yield* Latch.make(false)
        const observe = (ready: Latch.Latch, event: Latch.Latch) =>
          Stream.runForEach((notification: OpenCodeEvent) =>
            notification.type === "server.connected"
              ? ready.open
              : notification.type === "session.next.agent.switched" && notification.data.sessionID === sessionID
                ? event.open
                : Effect.void,
          )

        yield* first.events.subscribe().pipe(observe(firstReady, firstEvent), Effect.forkScoped)
        yield* second.events.subscribe().pipe(observe(secondReady, secondEvent), Effect.forkScoped)
        yield* Effect.all([firstReady.await, secondReady.await], { discard: true })
        yield* first.sessions.create({
          id: sessionID,
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })
        yield* first.sessions.switchAgent({ sessionID, agent: Agent.ID.make("plan") })

        yield* firstEvent.await.pipe(Effect.timeout("4 seconds"))
        expect(Option.isNone(yield* secondEvent.await.pipe(Effect.timeoutOption("100 millis")))).toBe(true)
      }),
    ),
  )
}, 30_000)

test("embedded client is available as a Layer service", async () => {
  const directory = location("layer-service")
  const { AbsolutePath, Location, OpenCode, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  const created = await Effect.runPromise(
    Effect.gen(function* () {
      const opencode = yield* OpenCode.Service
      yield* waitForLocation(opencode, directory)
      return yield* opencode.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
    }).pipe(Effect.provide(OpenCode.layer), Effect.scoped),
  )

  expect(created.id).toBe(sessionID)
}, 30_000)
