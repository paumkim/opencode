import { afterEach, describe, expect } from "bun:test"
import { Effect, Queue, Stream } from "effect"
import type * as Cause from "effect/Cause"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { EventV2 } from "@opencode-ai/core/event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// The per-subscriber backlog is bounded. A subscriber that opens the stream and
// then stops reading must not be able to grow the server heap without limit, and
// it must not be silently starved of events either: past the limit the stream is
// ended so the client reconnects and refetches authoritative state.
//
// These tests exercise the queue mechanics directly against the same Effect
// primitives the handler uses, so they pin the contract the handler depends on
// without needing to push 10k real events through the HTTP layer.
const LIMIT = 10_000

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)

describe("event subscriber backlog", () => {
  it.instance(
    "a bounded queue stops accepting once full instead of growing",
    () =>
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<EventV2.Payload, never>(LIMIT)

        let accepted = 0
        for (let i = 0; i < LIMIT; i++) {
          if (Queue.offerUnsafe(queue, { id: `evt_${i}`, type: "test.event", data: {} } as EventV2.Payload))
            accepted += 1
        }
        expect(accepted).toBe(LIMIT)

        // The next offer is refused. This is the assertion that the backlog is
        // bounded: an unbounded queue would accept it and grow.
        expect(Queue.offerUnsafe(queue, { id: "evt_overflow", type: "test.event", data: {} } as EventV2.Payload)).toBe(
          false,
        )
        expect(Queue.sizeUnsafe(queue)).toBe(LIMIT)
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "an unbounded queue keeps accepting, which is the behaviour being removed",
    () =>
      Effect.gen(function* () {
        // Control case. If this ever starts failing, the bounded-queue assertion
        // above has stopped proving anything.
        const queue = yield* Queue.unbounded<EventV2.Payload>()
        for (let i = 0; i < LIMIT + 1; i++) {
          expect(Queue.offerUnsafe(queue, { id: `evt_${i}`, type: "test.event", data: {} } as EventV2.Payload)).toBe(
            true,
          )
        }
        expect(Queue.sizeUnsafe(queue)).toBe(LIMIT + 1)
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "events below the limit are still delivered in order",
    () =>
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<EventV2.Payload, never>(LIMIT)
        for (let i = 0; i < 5; i++) {
          Queue.offerUnsafe(queue, { id: `evt_${i}`, type: "test.event", data: {} } as EventV2.Payload)
        }

        // Drain straight off the queue. A forked stream consumer here would race
        // the explicit takes below and make the order assertion meaningless.
        const received: string[] = []
        for (let i = 0; i < 5; i++) {
          const event = yield* Queue.take(queue)
          received.push(event.id)
        }
        expect(received).toEqual(["evt_0", "evt_1", "evt_2", "evt_3", "evt_4"])
        expect(Queue.sizeUnsafe(queue)).toBe(0)
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "ending the queue completes the stream so the client reconnects",
    () =>
      Effect.gen(function* () {
        // The handler ends the queue on overflow via Queue.endUnsafe. Ending a
        // queue must terminate Stream.fromQueue rather than leave the subscriber
        // hanging, otherwise the overflow path would turn into a stuck stream.
        const queue = yield* Queue.bounded<EventV2.Payload, Cause.Done>(4)
        Queue.offerUnsafe(queue, { id: "evt_1", type: "test.event", data: {} } as EventV2.Payload)
        yield* Queue.end(queue)

        const received: string[] = []
        yield* Stream.runForEach(Stream.fromQueue(queue), (event) =>
          Effect.sync(() => {
            received.push(event.id)
          }),
        )
        // The already-queued event is still delivered, then the stream completes.
        expect(received).toEqual(["evt_1"])
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "the live event stream stays open and delivers events",
    () =>
      Effect.gen(function* () {
        // End-to-end confirmation that bounding the queue did not break normal
        // streaming: connect, confirm the handshake, and confirm the response is
        // still an event stream that has not been closed early.
        const { directory } = yield* TestInstance
        const response = yield* requestInDirectory(EventPaths.event, directory)
        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("text/event-stream")
        expect(response.stream).toBeDefined()

        const chunks = yield* Queue.unbounded<Uint8Array>()
        yield* response.stream.pipe(
          Stream.runForEach((value) => Queue.offer(chunks, value)),
          Effect.forkScoped,
        )
        const first = yield* Queue.take(chunks).pipe(
          Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error("no event received")) }),
        )
        const text = new TextDecoder().decode(first)
        expect(text).toContain("server.connected")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
