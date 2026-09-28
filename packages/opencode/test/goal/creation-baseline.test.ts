import { describe, expect, test } from "bun:test"
import { fetchSessionTokens } from "@/goal/tools"
import type { Client } from "@/goal/shared"

/**
 * Builds a client whose `session.messages` resolves the given tuple, which is how the generated SDK
 * reports a non-2xx: a resolved result carrying `error`, not a rejected promise.
 */
function clientReturning(tuple: unknown) {
  return { session: { messages: async () => tuple } } as unknown as Client
}

describe("fetchSessionTokens", () => {
  test("reports the reason and yields null when the read failed", async () => {
    // The defect: a failed HTTP read resolved, so `.catch(() => null)` never ran, `result.data` was
    // absent, and the baseline silently became 0. `accountUsage` only re-anchors when the baseline
    // is null, so a persisted 0 charges the whole session history to the new goal.
    const reported: string[] = []
    const tokens = await fetchSessionTokens(
      clientReturning({ data: undefined, error: { data: { message: "database unavailable" } } }),
      "ses_1",
      (text) => reported.push(text),
    )

    // null, not 0: these two values are the entire difference between "anchor later" and
    // "charge the goal for the session's entire prior usage".
    expect(tokens).toBeNull()
    expect(tokens).not.toBe(0)
    expect(reported).toHaveLength(1)
    // The reason, not "[object object]" - the SDK's typed failure is a schema object.
    expect(reported[0]).toContain("failed to read session usage for goal creation")
    expect(reported[0]).toContain("database unavailable")
  })

  test("returns the real total from a successful read and reports nothing", async () => {
    const reported: string[] = []
    const tokens = await fetchSessionTokens(
      clientReturning({
        data: [
          { info: { role: "assistant", tokens: { input: 100, output: 50 } } },
          { info: { role: "user", tokens: { input: 25, output: 0 } } },
        ],
      }),
      "ses_1",
      (text) => reported.push(text),
    )
    expect(tokens).toBe(175)
    expect(reported).toEqual([])
  })

  test("returns 0 - not null - for a successful read of an empty session", async () => {
    // The distinction that must NOT be collapsed: a genuinely empty session has genuinely used no
    // tokens, and 0 is a real measurement that anchors accounting immediately. Reporting or
    // nulling this would make a fresh session wait for an observation that will read 0 as well.
    const reported: string[] = []
    const tokens = await fetchSessionTokens(clientReturning({ data: [] }), "ses_1", (text) => reported.push(text))
    expect(tokens).toBe(0)
    expect(reported).toEqual([])
  })
})
