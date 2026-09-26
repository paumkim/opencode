import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([SessionStatus.node, EventV2Bridge.node])))

describe("SessionStatus", () => {
  it.instance("updates state before synchronously publishing status and idle events", () =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = SessionID.make("session-status-ordering")
      const observed: Array<{
        readonly type: string
        readonly get: SessionStatus.Info
        readonly listed: SessionStatus.Info | undefined
      }> = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.gen(function* () {
          if (event.type !== SessionStatus.Event.Status.type && event.type !== SessionStatus.Event.Idle.type) return
          const listed = yield* status.list()
          observed.push({
            type: event.type,
            get: yield* status.get(sessionID),
            listed: listed.get(sessionID),
          })
        }),
      )

      yield* status.set(sessionID, { type: "busy" })
      yield* status.set(sessionID, { type: "idle" })
      yield* unsubscribe

      expect(observed).toEqual([
        { type: SessionStatus.Event.Status.type, get: { type: "busy" }, listed: { type: "busy" } },
        { type: SessionStatus.Event.Status.type, get: { type: "idle" }, listed: undefined },
        { type: SessionStatus.Event.Idle.type, get: { type: "idle" }, listed: undefined },
      ])
    }),
  )
})

const failure = new Error("status publication failed")
const failingBridge = Layer.mock(EventV2Bridge.Service, {
  publish: () => Effect.die(failure),
})
const failingIt = testEffect(LayerNode.compile(SessionStatus.node, [[EventV2Bridge.node, failingBridge]]))

describe("SessionStatus publication failures", () => {
  failingIt.instance("keeps the state update when publication fails", () =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const sessionID = SessionID.make("session-status-publication-failure")

      const result = yield* Effect.exit(status.set(sessionID, { type: "busy" }))
      expect(Exit.isFailure(result) ? Cause.squash(result.cause) : undefined).toBe(failure)
      expect(yield* status.get(sessionID)).toEqual({ type: "busy" })
      expect((yield* status.list()).get(sessionID)).toEqual({ type: "busy" })
    }),
  )
})
