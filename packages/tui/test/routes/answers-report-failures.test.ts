import { describe, expect, test } from "bun:test"
import { replyToPermission } from "../../src/routes/session/permission"
import { sendQuestionAnswer } from "../../src/routes/session/question"

// Both prompts used to fire their reply with `void`. The client resolves a
// non-2xx as `{data: undefined, error}` rather than rejecting, so a refused
// answer looked identical to an accepted one. The request or question stays on
// screen either way — only the `permission.replied` / `question.replied` event
// removes it — so nothing was lost, but the agent stayed blocked on an answer
// the user could see they had given, and a transport failure escaped as an
// unhandled rejection on top of that.
describe("replyToPermission", () => {
  test("a refused answer is reported and is not treated as answered", async () => {
    const reported: string[] = []
    const ok = await replyToPermission({
      send: async () => ({ data: undefined, error: { data: { message: "session not found" } } }),
      answer: { reply: "always" },
      report: (reason) => reported.push(reason),
    })
    expect(ok).toBe(false)
    expect(reported).toEqual(["session not found"])
  })

  test("a transport failure is reported rather than escaping unhandled", async () => {
    const reported: string[] = []
    const ok = await replyToPermission({
      send: async () => {
        throw new Error("connection refused")
      },
      answer: { reply: "once" },
      report: (reason) => reported.push(reason),
    })
    expect(ok).toBe(false)
    expect(reported).toEqual(["connection refused"])
  })

  test("an accepted answer reports nothing and succeeds", async () => {
    const reported: string[] = []
    const seen: unknown[] = []
    const ok = await replyToPermission({
      send: async (payload) => {
        seen.push(payload)
        return { data: true }
      },
      answer: { reply: "reject", message: "no" },
      report: (reason) => reported.push(reason),
    })
    expect(ok).toBe(true)
    expect(reported).toEqual([])
    // A rejection carries the reason through untouched.
    expect(seen).toEqual([{ reply: "reject", message: "no" }])
  })
})

describe("sendQuestionAnswer", () => {
  test("a refused answer is reported and is not treated as answered", async () => {
    const reported: string[] = []
    const ok = await sendQuestionAnswer({
      run: async () => ({ data: undefined, error: { data: { message: "question not found" } } }),
      action: "answer",
      report: (reason) => reported.push(reason),
    })
    expect(ok).toBe(false)
    expect(reported).toEqual(["question not found"])
  })

  test("a transport failure is reported rather than escaping unhandled", async () => {
    const reported: string[] = []
    const ok = await sendQuestionAnswer({
      run: async () => {
        throw new Error("socket closed")
      },
      action: "decline",
      report: (reason) => reported.push(reason),
    })
    expect(ok).toBe(false)
    expect(reported).toEqual(["socket closed"])
  })

  test("an accepted answer reports nothing and succeeds", async () => {
    const reported: string[] = []
    const ok = await sendQuestionAnswer({
      run: async () => ({}),
      action: "answer",
      report: (reason) => reported.push(reason),
    })
    expect(ok).toBe(true)
    expect(reported).toEqual([])
  })
})
