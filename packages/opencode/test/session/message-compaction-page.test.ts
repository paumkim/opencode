import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageV2 } from "@/session/message-v2"
import { Session as SessionNs } from "@/session/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// filterCompactedPaged replaces the full-session materialization that
// filterCompactedEffect performs. It is only safe if it returns exactly the same
// messages in exactly the same order, because the ordering encodes compaction
// semantics: the retained tail is spliced back in ahead of the summary. A
// mistake here silently loses or duplicates model context.
//
// So the assertion is equivalence against the original across shapes that hit
// each branch of the walk: empty, uncompacted, a single compaction with a tail
// anchor, and a history long enough to span pages.

const env = AppNodeBuilder.build(
  LayerNode.group([SessionNs.node, SessionProjector.node, Database.node, EventV2Bridge.node, CrossSpawnSpawner.node]),
  [[RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })]],
)

const it = testEffect(env)

afterEach(async () => {
  await disposeAllInstances()
})

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

function addUser(sessionID: SessionID, text: string) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        model: ref,
        agent: "build",
        time: { created: Date.now() },
      })
      yield* ssn.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
      return msg
    }),
  )
}

function addAssistant(sessionID: SessionID, parentID: MessageID, text: string, root: string, summary = false) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID,
        mode: summary ? "compaction" : "build",
        agent: summary ? "compaction" : "build",
        path: { cwd: root, root },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        parentID,
        summary,
        time: { created: Date.now() },
        finish: "end_turn",
        ...(summary ? {} : { error: undefined }),
      })
      yield* ssn.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
      return msg
    }),
  )
}

function addCompaction(sessionID: SessionID, tailStartID: MessageID) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: ref,
        sessionID,
        agent: "build",
        time: { created: Date.now() },
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "compaction",
        auto: false,
        tail_start_id: tailStartID,
      })
      return msg
    }),
  )
}

describe("MessageV2.filterCompactedPaged", () => {
  it.instance(
    "matches the original for an empty session",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service.use((ssn) => ssn.create({}))
        const streamed = yield* MessageV2.filterCompactedEffect(session.id)
        const paged = yield* MessageV2.filterCompactedPaged(session.id)
        expect(paged.map((m) => m.info.id)).toEqual(streamed.map((m) => m.info.id))
        expect(paged.length).toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "matches the original when nothing has been compacted",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service.use((ssn) => ssn.create({}))
        const test = yield* TestInstance
        for (const text of ["one", "two", "three"]) {
          const message = yield* addUser(session.id, text)
          yield* addAssistant(session.id, message.id, `reply-${text}`, test.directory)
        }

        const streamed = yield* MessageV2.filterCompactedEffect(session.id)
        const paged = yield* MessageV2.filterCompactedPaged(session.id)
        expect(paged.map((m) => m.info.id)).toEqual(streamed.map((m) => m.info.id))
        // Nothing was compacted, so everything is still retained.
        expect(paged.length).toBe(6)
      }),
    { git: true },
  )

  it.instance(
    "matches the original once a compaction with a tail anchor exists",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service.use((ssn) => ssn.create({}))
        const test = yield* TestInstance
        const dir = test.directory

        // Turns that get summarised away, then the tail that must be retained.
        for (const text of ["old-1", "old-2"]) {
          const message = yield* addUser(session.id, text)
          yield* addAssistant(session.id, message.id, `reply-${text}`, dir, true)
        }
        const tail = yield* addUser(session.id, "retained-tail")
        yield* addCompaction(session.id, tail.id)
        const summary = yield* addAssistant(session.id, tail.id, "summary-one", dir, true)
        yield* addUser(session.id, "after-compaction")

        const streamed = yield* MessageV2.filterCompactedEffect(session.id)
        const paged = yield* MessageV2.filterCompactedPaged(session.id)

        expect(paged.map((m) => m.info.id)).toEqual(streamed.map((m) => m.info.id))

        // And the original's shape is the one the model depends on.
        const ids = paged.map((m) => m.info.id)
        expect(ids).toContain(tail.id)
        expect(ids).toContain(summary.id)
        expect(paged.some((m) => m.info.role === "assistant" && m.info.summary)).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "matches the original across a history longer than one page",
    () =>
      Effect.gen(function* () {
        // The two implementations only diverge once the walk can stop early,
        // which needs enough history to span the 50-message page size.
        const session = yield* SessionNs.Service.use((ssn) => ssn.create({}))
        const test = yield* TestInstance
        const dir = test.directory

        const tail = yield* addUser(session.id, "retained-tail")
        for (let i = 0; i < 40; i++) {
          const message = yield* addUser(session.id, `old-${i}`)
          yield* addAssistant(session.id, message.id, `reply-${i}`, dir, true)
        }
        yield* addCompaction(session.id, tail.id)
        yield* addAssistant(session.id, tail.id, "summary-after-long-history", dir, true)
        yield* addUser(session.id, "newest")

        const streamed = yield* MessageV2.filterCompactedEffect(session.id)
        const paged = yield* MessageV2.filterCompactedPaged(session.id)
        expect(paged.map((m) => m.info.id)).toEqual(streamed.map((m) => m.info.id))
      }),
    { git: true },
  )
})
