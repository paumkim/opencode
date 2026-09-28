import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { replayFailure, replayFailures } from "@/acp/service"
import type { SessionMessageResponse } from "@opencode-ai/sdk/v2"

function message(id: string): SessionMessageResponse {
  return { info: { id, role: "assistant" }, parts: [] } as unknown as SessionMessageResponse
}

describe("replayFailures", () => {
  test("reports the reason a message could not be replayed and names which one", async () => {
    // The regression: the loop ended in `.catch(() => {})`, so a client that could not accept a
    // message was handed a silently incomplete transcript. Nothing observable came back — the
    // function returned void either way — so the report is the only thing that distinguishes them.
    const reported: string[] = []
    await Effect.runPromise(
      replayFailures(
        async (item) => {
          if (item.info.id === "msg_bad") throw new Error("connection closed")
        },
        [message("msg_1"), message("msg_bad"), message("msg_3")],
        (text) => reported.push(text),
      ),
    )

    const perMessage = reported.filter((text) => text.includes("failed to replay message"))
    expect(perMessage).toHaveLength(1)
    // Position, not just identity: the client needs to know it is missing the middle of the history.
    expect(perMessage[0]).toContain("message 2 of 3")
    expect(perMessage[0]).toContain("msg_bad")
    expect(perMessage[0]).toContain("connection closed")

    // A count, so a reader of the log learns the transcript is incomplete rather than guessing.
    expect(reported.some((t) => t.includes("1 of 3 message(s) could not be replayed"))).toBe(true)
  })

  test("keeps replaying after a failure so one bad message costs the client only that message", async () => {
    // Tolerating a single failure is the point of the per-message catch. Reverting to a whole-loop
    // catch would still report, so this pins the half of the fix that the report alone cannot.
    const seen: string[] = []
    const reported: string[] = []
    await Effect.runPromise(
      replayFailures(
        async (item) => {
          seen.push(item.info.id)
          if (item.info.id === "msg_1") throw new Error("boom")
        },
        [message("msg_1"), message("msg_2"), message("msg_3")],
        (text) => reported.push(text),
      ),
    )
    expect(seen).toEqual(["msg_1", "msg_2", "msg_3"])
    expect(reported.filter((t) => t.includes("failed to replay message"))).toHaveLength(1)
  })

  test("reports every failure when several messages are refused", async () => {
    const reported: string[] = []
    await Effect.runPromise(
      replayFailures(
        async (item) => {
          throw new Error(`refused ${item.info.id}`)
        },
        [message("a"), message("b")],
        (text) => reported.push(text),
      ),
    )
    expect(reported.filter((t) => t.includes("failed to replay message"))).toHaveLength(2)
    expect(reported.some((t) => t.includes("2 of 2 message(s) could not be replayed"))).toBe(true)
  })

  test("reports nothing when every message replays", async () => {
    const reported: string[] = []
    await Effect.runPromise(
      replayFailures(
        async () => {},
        [message("a"), message("b")],
        (text) => reported.push(text),
      ),
    )
    expect(reported).toEqual([])
  })

  test("reports nothing for an empty history", async () => {
    const reported: string[] = []
    await Effect.runPromise(
      replayFailures(
        async () => {},
        [],
        (text) => reported.push(text),
      ),
    )
    expect(reported).toEqual([])
  })
})

describe("replayFailure", () => {
  test("formats a structured SDK-style failure rather than stringifying it to an object", async () => {
    // Generated SDK clients return typed failures as schema objects, not Error instances, so
    // String(error) would yield "[object Object]" and the log would name no reason at all.
    const message = replayFailure(0, 2, "msg_x", { data: { message: "provider unreachable" } })
    expect(message).toBe("[acp] failed to replay message 1 of 2 (msg_x) to the client: provider unreachable")
  })
})
