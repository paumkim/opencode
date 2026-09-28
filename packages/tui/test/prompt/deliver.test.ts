import { describe, expect, test } from "bun:test"
import { deliverPrompt } from "../../src/component/prompt/deliver"

// A prompt, command or shell invocation the shared-workspace socket could not
// deliver used to vanish: `send` returned quietly, and the caller went on to
// `input.clear()` and `setStore("prompt", { input: "" })` regardless. The typed
// text was gone, `finishSubmit` reported a normal submit, and the agent never
// responded. The HTTP shell and command branches were worse in a different way
// — they had no `.catch()` at all, so a transport failure was dropped silently.
describe("deliverPrompt", () => {
  test("reports a socket drop so the caller can keep the text", () => {
    const reported: string[] = []
    const delivered = deliverPrompt({
      kind: "prompt",
      shared: () => false,
      report: (title, message) => reported.push(`${title}: ${message}`),
    })
    expect(delivered).toBe(false)
    expect(reported).toEqual([])
  })

  test("stays quiet when the socket accepted the message", () => {
    const reported: string[] = []
    const delivered = deliverPrompt({
      kind: "prompt",
      shared: () => true,
      report: (title, message) => reported.push(`${title}: ${message}`),
    })
    expect(delivered).toBe(true)
    expect(reported).toEqual([])
  })

  test("treats the socket as authoritative and never also calls http", async () => {
    let httpCalled = false
    deliverPrompt({
      kind: "shell",
      shared: () => false,
      http: async () => {
        httpCalled = true
        return {}
      },
      report: () => {},
    })
    expect(httpCalled).toBe(false)
  })

  test("reports a transport failure on the http transport", async () => {
    const reported: string[] = []
    const delivered = deliverPrompt({
      kind: "command",
      http: async () => {
        throw new Error("connection reset")
      },
      report: (title, message) => reported.push(`${title}: ${message}`),
    })
    // The request is already in flight, so this cannot know it failed. The
    // prompt is already cleared at that point and is recoverable from the
    // editor history, which is the asymmetry the socket path does not have.
    expect(delivered).toBe(true)
    await Bun.sleep(10)
    expect(reported).toEqual(["Failed to send command: connection reset"])
  })

  test("says nothing when the http transport succeeds", async () => {
    const reported: string[] = []
    deliverPrompt({
      kind: "prompt",
      http: async () => ({ data: undefined }),
      report: (title, message) => reported.push(`${title}: ${message}`),
    })
    await Bun.sleep(10)
    expect(reported).toEqual([])
  })
})
