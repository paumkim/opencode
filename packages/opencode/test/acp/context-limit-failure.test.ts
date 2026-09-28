import { describe, expect, test } from "bun:test"
import { contextLimitFailure, reportedLimit } from "@/acp/service"

// The provider read behind the ACP context indicator ended in `.catch(() => undefined)`. Tolerating
// the failure is right — `contextLimit` returns `number | undefined` and the caller skips the usage
// update when it is missing — but dropping the reason was not. `sendUpdate` does `if (!size) return`,
// so a failed read meant the context indicator simply stopped updating, and the promise is memoised
// in `limits` for the process, so it never came back. The `messages` fetch beside it logs its failure
// for the same reason; this path did not.
describe("contextLimitFailure", () => {
  test("names the reason an Error carried", () => {
    const message = contextLimitFailure(new Error("socket hang up"))
    expect(message).toContain("failed to read providers for the context limit")
    expect(message).toContain("socket hang up")
  })

  test("carries a typed SDK error object, which is not an Error instance", () => {
    // The SDK resolves typed failures as schema objects, so a guard on `instanceof Error` would miss
    // every one of them — the same trap as the session-share notice.
    const message = contextLimitFailure({ data: { message: "instance load failed" }, name: "InstanceLoadError" })
    expect(message).toContain("instance load failed")
  })

  test("does not render a reason-less failure as a bare colon", () => {
    const message = contextLimitFailure({})
    expect(message).not.toMatch(/:$/)
    expect(message.length).toBeGreaterThan("[acp] failed to read providers for the context limit: ".length)
  })
})

describe("reportedLimit", () => {
  test("reports the reason a read failed and yields no limit", async () => {
    // The regression: the catch was `.catch(() => undefined)`, which produced the same `undefined`
    // and reported nothing, so this assertion is the only thing that distinguishes the two.
    const reported: string[] = []
    const result = await reportedLimit(Promise.reject(new Error("socket hang up")), (m) => reported.push(m))
    expect(result).toBeUndefined()
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain("failed to read providers for the context limit")
    expect(reported[0]).toContain("socket hang up")
  })

  test("passes a successful limit through untouched and reports nothing", async () => {
    const reported: string[] = []
    expect(await reportedLimit(Promise.resolve(200000), (m) => reported.push(m))).toBe(200000)
    expect(reported).toEqual([])
  })

  test("treats a genuine unknown limit as a success, not a failure", async () => {
    // A model with no published context limit resolves to undefined without ever failing. That must
    // not be reported as a failure, or every model without a published limit would log a warning.
    const reported: string[] = []
    expect(await reportedLimit(Promise.resolve(undefined), (m) => reported.push(m))).toBeUndefined()
    expect(reported).toEqual([])
  })
})
