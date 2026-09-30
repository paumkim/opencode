import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const ask = (input: Omit<Parameters<Permission.Interface["ask"]>[0], "id">) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

const list = Effect.gen(function* () {
  const permission = yield* Permission.Service
  return yield* permission.list()
})

/**
 * Start an ask that will block, wait for it to be pending, and hand back both so
 * the test can look at the published request and then release it. A permission
 * ask is a promise, so the only way to see one is to fork it and look while it
 * is still open.
 */
const pendingAsk = (input: Omit<Parameters<Permission.Interface["ask"]>[0], "id">) =>
  Effect.gen(function* () {
    const fiber: Fiber.Fiber<void, unknown> = yield* ask(input).pipe(Effect.forkScoped)
    const permission = yield* Permission.Service
    const requests = yield* Effect.gen(function* () {
      while (true) {
        const found = yield* permission.list()
        if (found.length > 0) return found
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.fail(new Error("timed out waiting for the permission request")),
      }),
    )
    yield* permission.reply({ requestID: requests[0].id, reply: "reject" })
    return { request: requests[0], fiber }
  })

/**
 * A client never calls the service: it reads the event. So the reason has to
 * survive the trip through the published event, not just the in-memory pending
 * list, or the field is only ever visible to a test that looks in the right
 * place.
 */
const askedEvent = (input: Omit<Parameters<Permission.Interface["ask"]>[0], "id">) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const seen = yield* Deferred.make<PermissionV1.Request>()
    const unsub = yield* events.listen((event) => {
      if (event.type === Permission.Event.Asked.type) {
        Deferred.doneUnsafe(seen, Effect.succeed(event.data as PermissionV1.Request))
      }
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsub)
    const fiber = yield* ask(input).pipe(Effect.forkScoped)
    const permission = yield* Permission.Service
    const pending = yield* Effect.gen(function* () {
      while (true) {
        const found = yield* permission.list()
        if (found.length > 0) return found
        yield* Effect.sleep("10 millis")
      }
    })
    yield* permission.reply({ requestID: pending[0].id, reply: "reject" })
    return yield* Deferred.await(seen).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.fail(new Error("timed out waiting for the permission asked event")),
      }),
    )
  })

describe("permission ask carries the rule that asked", () => {
  it.instance(
    "names the rule and where it sits in the ruleset",
    () =>
      Effect.gen(function* () {
        const { request } = yield* pendingAsk({
          sessionID: SessionID.make("session_matched"),
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "edit", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "rm*", action: "ask" },
          ],
        })
        expect(request.matched).toEqual([
          {
            pattern: "rm -rf /",
            rule: { permission: "bash", pattern: "rm*", action: "ask" },
            // The second rule of two, so the prompt can say "rule 2/2" and mean
            // what `permission explain` means by it.
            index: 1,
            total: 2,
          },
        ])
      }),
    { git: true },
  )

  it.instance(
    "records one entry per pattern that needed asking",
    () =>
      Effect.gen(function* () {
        const { request } = yield* pendingAsk({
          sessionID: SessionID.make("session_multi"),
          permission: "bash",
          patterns: ["ls", "rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        })
        expect(request.matched?.map((item) => item.pattern)).toEqual(["ls", "rm -rf /"])
        // Both were decided by the same single rule, and both say so with the
        // same index rather than inventing one per pattern.
        expect(new Set(request.matched?.map((item) => item.index))).toEqual(new Set([0]))
      }),
    { git: true },
  )

  it.instance(
    "leaves out the patterns a rule allowed, so the reason is the actual question",
    () =>
      Effect.gen(function* () {
        const { request } = yield* pendingAsk({
          sessionID: SessionID.make("session_mixed"),
          permission: "bash",
          patterns: ["ls", "rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "ls*", action: "allow" }],
        })
        // `ls` was allowed by the rule, so it never becomes a question; only the
        // pattern that needed asking is listed as a reason.
        expect(request.matched?.map((item) => item.pattern)).toEqual(["rm -rf /"])
      }),
    { git: true },
  )

  it.instance(
    "says the default asked, which is the most common reason of all",
    () =>
      Effect.gen(function* () {
        const { request } = yield* pendingAsk({
          sessionID: SessionID.make("session_default"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "edit", pattern: "*", action: "allow" }],
        })
        // A user stopped by a question nothing in their config covers needs to
        // hear that, not silence: "no rule covers this" is the answer.
        expect(request.matched).toEqual([
          { pattern: "ls", rule: { permission: "bash", pattern: "*", action: "ask" }, index: -1, total: 1 },
        ])
      }),
    { git: true },
  )

  it.instance(
    "carries no reason at all when nothing needed asking",
    () =>
      Effect.gen(function* () {
        yield* ask({
          sessionID: SessionID.make("session_allowed"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
        })
        // Nothing was published, so there is no prompt to explain and nothing
        // can claim a rule asked.
        expect(yield* list).toEqual([])
      }),
    { git: true },
  )
  it.instance(
    "publishes the reason on the event a client actually reads",
    () =>
      Effect.gen(function* () {
        const event: PermissionV1.Request = yield* askedEvent({
          sessionID: SessionID.make("session_wire"),
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "edit", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "rm*", action: "ask" },
          ],
        })
        expect(event.matched).toEqual([
          { pattern: "rm -rf /", rule: { permission: "bash", pattern: "rm*", action: "ask" }, index: 1, total: 2 },
        ])
      }),
    { git: true },
  )
})
