import { describe, expect, test } from "bun:test"
import { resolveSession } from "@/cli/cmd/run/session.shared"
import type { RunInput } from "@/cli/cmd/run/types"

/**
 * Models the generated SDK client's actual contract: a typed HTTP failure comes
 * back as `{ data: undefined, error }` on the *resolved* value, and only
 * rejects when the caller asks for it with `throwOnError`. A stub that merely
 * rejected would not have caught the original defect, because the original
 * defect was precisely that nothing here ever asked.
 */
function stubSdk(result: { data?: unknown[]; error?: unknown }) {
  const calls: { throwOnError: boolean }[] = []
  const sdk = {
    session: {
      messages: async (_input: unknown, options?: { throwOnError?: boolean }) => {
        const throwOnError = options?.throwOnError === true
        calls.push({ throwOnError })
        if (result.error && throwOnError) throw new Error("session.messages failed")
        return result
      },
    },
  }
  return { sdk: sdk as unknown as RunInput["sdk"], calls }
}

describe("resolveSession", () => {
  test("asks the client to throw, so a typed failure is a failure", async () => {
    const { sdk, calls } = stubSdk({ data: [], error: { data: { message: "not found" } } })
    await resolveSession(sdk, "session-1").catch(() => undefined)
    expect(calls).toEqual([{ throwOnError: true }])
  })

  // The regression: a 404/500/timeout used to resolve to `{ data: undefined }`,
  // `?? []` made that an empty session, and `first: true` is exactly what a
  // genuinely new session looks like. `opencode run --resume` then hid the
  // history and carried on with no context.
  test("rejects instead of inventing an empty session when the read failed", async () => {
    const { sdk } = stubSdk({ data: undefined, error: { data: { message: "boom" } } })
    await expect(resolveSession(sdk, "session-1")).rejects.toThrow()
  })

  test("still reports a genuinely empty session as first", async () => {
    const { sdk } = stubSdk({ data: [] })
    const session = await resolveSession(sdk, "session-1")
    expect(session.first).toBe(true)
    expect(session.turns).toEqual([])
  })

  test("does not treat a failed read as first", async () => {
    const failed = await resolveSession(
      stubSdk({ data: undefined, error: { data: { message: "boom" } } }).sdk,
      "session-1",
    ).then(
      (s) => s.first,
      () => "rejected" as const,
    )
    expect(failed).not.toBe(true)
  })
})
