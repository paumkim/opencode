import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { Durable } from "../src/durable-event-manifest"
import { EventManifest } from "../src/event-manifest"
import { Event } from "../src/event"
import { Fanout } from "../src/fanout"
import { FanoutEvent } from "../src/fanout-event"
import { SessionID } from "../src/session-id"

const settled = {
  groupID: Fanout.GroupID.create(),
  parentSessionID: SessionID.create(),
  workerID: Fanout.WorkerID.create(),
  sessionID: SessionID.create(),
  description: "audit the parser",
  status: "done",
  digest: "parser accepts 3 inputs",
  timestamp: DateTime.makeUnsafe(1_700_000_000_000),
} as const

describe("fanout events", () => {
  test("are durable on the group aggregate so a crew outlives its parent's transcript", () => {
    expect(FanoutEvent.GroupOpened.durable).toEqual({ aggregate: "groupID", version: 1 })
    expect(FanoutEvent.WorkerJoined.durable).toEqual({ aggregate: "groupID", version: 1 })
    expect(FanoutEvent.WorkerSettled.durable).toEqual({ aggregate: "groupID", version: 1 })
  })

  test("are registered for durable decode without widening the server event contract", () => {
    expect(Durable.get("fanout.worker.settled.1")).toBe(FanoutEvent.WorkerSettled)
    expect(Durable.get("fanout.worker.joined.1")).toBe(FanoutEvent.WorkerJoined)
    expect(Durable.get("fanout.group.opened.1")).toBe(FanoutEvent.GroupOpened)
    expect(EventManifest.Latest.get("fanout.worker.settled")).toBe(FanoutEvent.WorkerSettled)
    expect(EventManifest.ServerDefinitions.map((definition) => definition.type)).not.toContain("fanout.worker.settled")
  })

  test("round-trip a settled result through the durable codec", () => {
    const id = Event.ID.create()
    // Durable rows are stored and replayed in the encoded form, so the codec has
    // to survive encode -> decode without inventing or dropping a field.
    const stored = Schema.encodeSync(FanoutEvent.Durable)({
      id,
      type: FanoutEvent.WorkerSettled.type,
      durable: { aggregateID: settled.groupID, seq: 4, version: 1 },
      data: settled,
    })
    expect(stored.data).toEqual({ ...settled, timestamp: 1_700_000_000_000 })

    const decoded = Schema.decodeUnknownSync(FanoutEvent.Durable)(stored)
    expect(decoded.type).toBe("fanout.worker.settled")
    if (decoded.type !== "fanout.worker.settled") throw new Error("unreachable")
    expect(decoded.data.digest).toBe("parser accepts 3 inputs")
    expect(decoded.data.workerID).toBe(settled.workerID)
  })

  test("keep an absent digest absent rather than inventing an empty one", () => {
    const { digest, ...withoutDigest } = settled
    const stored = Schema.encodeSync(FanoutEvent.Durable)({
      id: Event.ID.create(),
      type: FanoutEvent.WorkerSettled.type,
      durable: { aggregateID: settled.groupID, seq: 5, version: 1 },
      data: { ...withoutDigest, status: "error", error: "provider refused" },
    })
    expect("digest" in stored.data).toBe(false)

    const decoded = Schema.decodeUnknownSync(FanoutEvent.Durable)(stored)
    if (decoded.type !== "fanout.worker.settled") throw new Error("unreachable")
    expect(decoded.data.digest).toBeUndefined()
    expect(decoded.data.error).toBe("provider refused")
  })
})
