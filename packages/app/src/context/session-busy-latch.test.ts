import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode-ai/client/promise"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createServerSession } from "@/context/server-session"
import { followupDrainable } from "@/pages/session/followup-drain"
import { sendFollowupDraft, type FollowupDraft } from "@/components/prompt-input/submit"

const open = () => {
  const sent: { sessionID: string; id: string }[] = []
  const store = createServerSession({} as OpencodeClient)
  const apply = (event: object) => store.applyV2(event as OpenCodeEvent)
  const sync = {
    data: { command: [] as { name: string }[] },
    session: {
      optimistic: {
        add: () => {},
        remove: () => {},
      },
    },
  }
  const draft: FollowupDraft = {
    sessionID: "ses_1",
    sessionDirectory: "/repo",
    prompt: [{ type: "text", content: "next question", start: 0, end: 14 }],
    context: [],
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
  }
  const api = {
    prompt: async (input: { sessionID: string; id: string }) => {
      sent.push(input)
      return {} as never
    },
  }
  return { store, apply, sent, api, sync, draft }
}

const phase = (type: string, id: string) => ({
  id,
  created: 1,
  type,
  durable: { aggregateID: "ses_1", seq: 1, version: 1 },
  location: { directory: "/repo" },
  data: { sessionID: "ses_1" },
})

describe("session busy latch", () => {
  test("a submit does not latch the session busy on its own", async () => {
    const { store, api, sync, draft } = open()

    // A submit used to write `busy` here, optimistically. The only thing that
    // ever cleared it was a server event that the v2 runtime never published, so
    // on protocol v2 the session read as busy for the life of the page.
    expect(await sendFollowupDraft({ api: api as never, sync: sync as never, draft })).toBe(true)
    expect(store.data.session_status.ses_1).toBeUndefined()
    expect(store.data.session_working("ses_1")).toBe(false)
  })

  test("a finished turn reports idle and lets a queued follow-up drain", () => {
    const { store, apply } = open()

    apply(phase("session.execution.started", "evt_busy"))
    expect(store.data.session_working("ses_1")).toBe(true)
    expect(
      followupDrainable({
        working: store.data.session_working("ses_1"),
        blocked: false,
        child: false,
        paused: false,
        failed: false,
        sending: false,
      }),
    ).toBe(false)

    apply(phase("session.execution.succeeded", "evt_idle"))
    expect(store.data.session_status.ses_1).toEqual({ type: "idle" })
    expect(store.data.session_working("ses_1")).toBe(false)
    expect(
      followupDrainable({
        working: store.data.session_working("ses_1"),
        blocked: false,
        child: false,
        paused: false,
        failed: false,
        sending: false,
      }),
    ).toBe(true)
  })

  test("an interrupted turn is idle too, not stuck busy", () => {
    const { store, apply } = open()
    apply(phase("session.execution.started", "evt_busy"))
    apply({
      id: "evt_interrupt",
      created: 2,
      type: "session.execution.interrupted",
      durable: { aggregateID: "ses_1", seq: 2, version: 1 },
      location: { directory: "/repo" },
      data: { sessionID: "ses_1", reason: "user" },
    })
    expect(store.data.session_working("ses_1")).toBe(false)
  })

  test("a failed turn is idle too", () => {
    const { store, apply } = open()
    apply(phase("session.execution.started", "evt_busy"))
    apply({
      id: "evt_failed",
      created: 2,
      type: "session.execution.failed",
      durable: { aggregateID: "ses_1", seq: 2, version: 1 },
      location: { directory: "/repo" },
      data: { sessionID: "ses_1", error: { type: "unknown", message: "provider unavailable" } },
    })
    expect(store.data.session_working("ses_1")).toBe(false)
  })
})
