import { describe, expect, test } from "bun:test"
import { mutateRemote } from "../../src/util/mutate-remote"

describe("mutateRemote", () => {
  test("reports success only when the server accepted it", async () => {
    const reported: string[] = []
    const ok = await mutateRemote(
      async () => ({ data: true }),
      (reason) => reported.push(reason),
    )
    expect(ok).toBe(true)
    expect(reported).toEqual([])
  })

  // The defect this exists for. The client resolves a non-2xx as
  // `{data: undefined, error}`, so a refused mutation looks exactly like a
  // successful one to `void client.revert(...)`. `session.revert` answers 409
  // while a session is running, and the TUI refilled the prompt regardless.
  test("a typed error is reported and is not success", async () => {
    const reported: string[] = []
    const ok = await mutateRemote(
      async () => ({ data: undefined, error: { name: "SessionBusyError", data: { message: "session is busy" } } }),
      (reason) => reported.push(reason),
    )
    expect(ok).toBe(false)
    expect(reported).toEqual(["session is busy"])
  })

  test("a transport rejection is reported rather than escaping unhandled", async () => {
    const reported: string[] = []
    const ok = await mutateRemote(
      async () => {
        throw new Error("connection refused")
      },
      (reason) => reported.push(reason),
    )
    expect(ok).toBe(false)
    expect(reported).toEqual(["connection refused"])
  })

  test("a falsy-but-present error is still a refusal", async () => {
    const reported: string[] = []
    const ok = await mutateRemote(
      async () => ({ data: undefined, error: 0 }),
      (reason) => reported.push(reason),
    )
    expect(ok).toBe(false)
    expect(reported).toHaveLength(1)
  })

  // A 204 carries no body, so `data` is legitimately absent on a success. Only
  // an error makes a mutation a failure.
  test("an empty successful response counts as success", async () => {
    const reported: string[] = []
    const ok = await mutateRemote(
      async () => ({}),
      (reason) => reported.push(reason),
    )
    expect(ok).toBe(true)
    expect(reported).toEqual([])
  })

  test("the run function is awaited before the verdict is returned", async () => {
    let settled = false
    const ok = await mutateRemote(
      async () => {
        await Bun.sleep(5)
        settled = true
        return { data: true }
      },
      () => {},
    )
    expect(settled).toBe(true)
    expect(ok).toBe(true)
  })
})
