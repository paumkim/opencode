import { describe, expect, test } from "bun:test"
import { shareNotice } from "@/cli/cmd/run"

// The generated SDK resolves typed HTTP failures through `.error` as schema objects — for
// `session.share`, a `BadRequestError | NotFoundError | EffectHttpApiErrorInternalServerError |
// InstanceLoadError` — rather than rejecting. The old code only noticed a failure inside a
// `.catch`, so it saw transport rejections and nothing else, and its `error instanceof Error` guard
// was false for every typed error. The "disabled" message it tried to surface is carried by exactly
// the typed errors that could never reach it, and a 400/404/500 fell through the `!res.error`
// success check and printed nothing at all: the user asked for `run --share` and got no URL and no
// explanation.
describe("shareNotice", () => {
  // Shaped like the SDK's typed error: a plain object, not an Error instance.
  const typedError = (message: string, extra?: Record<string, unknown>) => ({ data: { message }, ...extra })

  test("prints the share URL when the server shares", () => {
    expect(shareNotice({ data: { share: { url: "https://oc.dev/s/abc" } } })).toEqual({
      danger: false,
      prefix: "~  ",
      text: "https://oc.dev/s/abc",
    })
  })

  test("reports a typed not-found error instead of printing nothing", () => {
    // The regression: this returned undefined, so nothing was printed.
    const notice = shareNotice({ error: typedError("session not found") })
    expect(notice?.danger).toBe(true)
    expect(notice?.text).toBe("Failed to share session: session not found")
  })

  test("reports a typed internal error, which the old instanceof check could not see", () => {
    const notice = shareNotice({ error: { data: { message: "boom" }, status: 500 } })
    expect(notice?.danger).toBe(true)
    expect(notice?.text).toContain("boom")
  })

  test("still surfaces the deliberate 'disabled' refusal with its own wording", () => {
    const notice = shareNotice({ error: typedError("sharing is disabled for this session") })
    expect(notice?.danger).toBe(true)
    // Not prefixed: the server already explained it, and it is a refusal rather than a failure.
    expect(notice?.text).toBe("sharing is disabled for this session")
  })

  test("keeps the 'disabled' wording for a rejected Error too", () => {
    const notice = shareNotice({ error: new Error("share disabled by config") })
    expect(notice?.text).toBe("share disabled by config")
  })

  test("reports a transport rejection, which the old .catch did see", () => {
    const notice = shareNotice({ error: new TypeError("fetch failed") })
    expect(notice?.text).toBe("Failed to share session: fetch failed")
  })

  test("does not render a message-less error as an empty report", () => {
    // The trap this guards: an error object with no message must not produce a bare ": " line.
    const notice = shareNotice({ error: {} })
    expect(notice?.text).not.toBe("Failed to share session: ")
    expect(notice?.text.length).toBeGreaterThan("Failed to share session: ".length)
  })

  test("says nothing when the server shared without a URL", () => {
    expect(shareNotice({ data: { share: { url: null } } })).toBeUndefined()
    expect(shareNotice({ data: null })).toBeUndefined()
    expect(shareNotice({})).toBeUndefined()
  })
})
