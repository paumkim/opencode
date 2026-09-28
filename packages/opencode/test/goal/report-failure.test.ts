import { describe, expect, test } from "bun:test"
import { reportGoalFailure } from "@/goal/driver"
import type { Client } from "@/goal/shared"

/** Captures what the helper writes to the console, which is the fallback when the log file is broken. */
function captureConsole() {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "))
  }
  return {
    lines,
    restore: () => {
      console.error = original
    },
  }
}

function clientWithLog(log: (body: unknown) => Promise<unknown>) {
  const sent: unknown[] = []
  const client = {
    app: {
      log: async (input: { body: unknown }) => {
        sent.push(input.body)
        return log(input.body)
      },
    },
  } as unknown as Client
  return { client, sent }
}

describe("reportGoalFailure", () => {
  test("writes the failure to the server log and reports nothing to the console", async () => {
    const { client, sent } = clientWithLog(async () => ({ data: true }))
    const cap = captureConsole()
    try {
      await reportGoalFailure(client, "Auto-continue failed", new Error("provider unreachable"))
    } finally {
      cap.restore()
    }
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      service: "opencode-goal",
      level: "error",
      message: "Auto-continue failed",
    })
    expect((sent[0] as { extra: { error: string } }).extra.error).toBe("provider unreachable")
    expect(cap.lines).toEqual([])
  })

  test("reports to the console when the log call is refused, and names the original failure", async () => {
    // The regression. `app.log` resolves a non-2xx as a result tuple carrying `error` rather than
    // rejecting, so the old `try/catch` never saw it: a goal that keeps failing stopped recording
    // why, with no signal anywhere. The two message names matter - the operator has to be able to
    // tell which of the two failure paths went quiet.
    const { client } = clientWithLog(async () => ({ data: undefined, error: { message: "log sink unavailable" } }))
    const cap = captureConsole()
    try {
      await reportGoalFailure(client, "Turn watchdog retry failed", new Error("provider unreachable"))
    } finally {
      cap.restore()
    }
    expect(cap.lines).toHaveLength(1)
    expect(cap.lines[0]).toContain("could not write")
    // Both failures named, in one line: the one being reported, and the one reporting it failed.
    expect(cap.lines[0]).toContain("Turn watchdog retry failed")
    expect(cap.lines[0]).toContain("log sink unavailable")
  })

  test("reports to the console when the log call rejects", async () => {
    // The other failure mode, which the old code did catch - kept so the fallback covers both.
    const { client } = clientWithLog(async () => {
      throw new Error("ECONNREFUSED")
    })
    const cap = captureConsole()
    try {
      await reportGoalFailure(client, "Auto-continue failed", new Error("boom"))
    } finally {
      cap.restore()
    }
    expect(cap.lines).toHaveLength(1)
    expect(cap.lines[0]).toContain("ECONNREFUSED")
  })

  test("names a structured failure instead of rendering it as an object", async () => {
    // The SDK returns typed failures as schema objects, so a bare String(error) would make the log
    // entry say "[object Object]" and name no reason at all. The log call itself succeeds here, so
    // the only thing being checked is what reached the log entry.
    const { client, sent } = clientWithLog(async () => ({ data: true }))
    const cap = captureConsole()
    try {
      await reportGoalFailure(client, "Auto-continue failed", { data: { message: "rate limited" } })
    } finally {
      cap.restore()
    }
    // The reason survives. `errorDetail` JSON-stringifies a structured failure, so the value is
    // embedded rather than lifted out - what matters is that "rate limited" is in there and that
    // "[object Object]" is not, which is what the old String(error) would have produced.
    const logged = (sent[0] as { extra: { error: string } }).extra.error
    expect(logged).toContain("rate limited")
    expect(logged).not.toContain("[object Object]")
    expect(cap.lines).toEqual([])
  })

  test("never throws, so a failed log cannot replace the failure the caller is handling", async () => {
    // The callers are already inside a catch block. Replacing the original error with "the log call
    // also failed" would lose the cause the user actually needs.
    const { client } = clientWithLog(async () => {
      throw new Error("everything is down")
    })
    const cap = captureConsole()
    try {
      await reportGoalFailure(client, "Auto-continue failed", new Error("the original cause"))
      // Reaching here is the assertion.
      expect(true).toBe(true)
    } finally {
      cap.restore()
    }
  })
})
