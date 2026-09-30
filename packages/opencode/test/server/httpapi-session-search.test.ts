import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session as SessionNs } from "@/session/session"

import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import type { SessionSearch } from "../../src/session/search"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(SessionNs.node), httpApiLayer))

const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test"),
}

afterEach(async () => {
  await disposeAllInstances()
})

const withoutWatcher = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  if (process.platform !== "win32") return effect
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
      process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
        else process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = previous
      }),
  )
}

const sessionScoped = Effect.acquireRelease(SessionNs.use.create({}), (session) =>
  SessionNs.use.remove(session.id).pipe(Effect.ignore),
)

/** Writes one user message per entry, the same shape the prompt path persists. */
const fill = Effect.fn("SessionSearchTest.fill")(function* (sessionID: SessionID, texts: string[]) {
  const session = yield* SessionNs.Service
  return yield* Effect.forEach(texts, (text) =>
    Effect.gen(function* () {
      const id = MessageID.ascending()
      yield* session.updateMessage({
        id,
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "test",
        model,
        tools: {},
      } satisfies SessionV1.User)
      const partID = PartID.ascending()
      yield* session.updatePart({
        id: partID,
        sessionID,
        messageID: id,
        type: "text",
        text,
      } satisfies SessionV1.TextPart)
      return { messageID: id, partID }
    }),
  )
})

function request(path: string) {
  return TestInstance.pipe(Effect.flatMap((test) => requestInDirectory(path, test.directory)))
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((body) => body as T))
}

const search = (query: string, extra = "") => request(`/session/search?q=${encodeURIComponent(query)}${extra}`)

describe("session search endpoint", () => {
  it.instance(
    "returns matching parts with the ids and snippet a client needs to jump to them",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const [first, second] = yield* fill(session.id, [
          "how do I rotate the database password?",
          "run the rotation job",
        ])

        const res = yield* search("rotate the database")
        expect(res.status).toBe(200)
        const hits = yield* json<SessionSearch.Hit[]>(res)
        expect(hits).toHaveLength(1)
        expect(hits[0]).toMatchObject({
          sessionID: session.id,
          messageID: first.messageID,
          partID: first.partID,
          role: "user",
          matches: 1,
          snippet: "how do I rotate the database password?",
          snippetStart: 0,
        })
        expect(hits[0].sessionTitle).toBeTruthy()
        expect(second.messageID).not.toBe(hits[0].messageID)
      }),
    ),
    { git: true },
  )

  it.instance(
    "scopes to one session and honours the limit",
    withoutWatcher(
      Effect.gen(function* () {
        const first = yield* sessionScoped
        yield* fill(first.id, ["needle one", "needle two", "needle three"])
        const second = yield* Effect.acquireRelease(SessionNs.use.create({}), (session) =>
          SessionNs.use.remove(session.id).pipe(Effect.ignore),
        )
        yield* fill(second.id, ["needle elsewhere"])

        const all = yield* json<SessionSearch.Hit[]>(yield* search("needle"))
        expect(all).toHaveLength(4)

        const scoped = yield* json<SessionSearch.Hit[]>(yield* search("needle", `&session=${first.id}`))
        expect(scoped).toHaveLength(3)
        expect(scoped.every((hit) => hit.sessionID === first.id)).toBe(true)

        const limited = yield* json<SessionSearch.Hit[]>(yield* search("needle", "&limit=2"))
        expect(limited).toHaveLength(2)
      }),
    ),
    { git: true },
  )

  it.instance(
    "folds case by default and matches exactly with case=true",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* fill(session.id, ["Token REFRESH failed"])

        expect(yield* json<SessionSearch.Hit[]>(yield* search("token refresh"))).toHaveLength(1)
        expect(yield* json<SessionSearch.Hit[]>(yield* search("token refresh", "&case=true"))).toHaveLength(0)
        expect(yield* json<SessionSearch.Hit[]>(yield* search("Token REFRESH", "&case=true"))).toHaveLength(1)
      }),
    ),
    { git: true },
  )

  it.instance(
    "returns an empty list rather than matching everything for a blank query",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* fill(session.id, ["anything at all"])
        expect(yield* json<SessionSearch.Hit[]>(yield* search("   "))).toEqual([])
      }),
    ),
    { git: true },
  )

  it.instance(
    "rejects a missing query and a limit outside the accepted range",
    withoutWatcher(
      Effect.gen(function* () {
        expect((yield* request(`/session/search`)).status).toBe(400)
        expect((yield* search("anything", "&limit=0")).status).toBe(400)
        expect((yield* search("anything", "&limit=501")).status).toBe(400)
        expect((yield* search("anything", "&limit=1.5")).status).toBe(400)
        expect((yield* search("anything", "&case=maybe")).status).toBe(400)
      }),
    ),
    { git: true },
  )

  it.instance(
    "does not collide with the /session/:sessionID route",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* fill(session.id, ["collision probe"])

        // The literal segment has to win, or this resolves as a session id.
        const res = yield* search("collision probe")
        expect(res.status).toBe(200)
        expect(yield* json<SessionSearch.Hit[]>(res)).toHaveLength(1)

        const single = yield* request(`/session/${session.id}`)
        expect(single.status).toBe(200)
        expect((yield* json<{ id: string }>(single)).id).toBe(session.id)
      }),
    ),
    { git: true },
  )
})
