import { describe, expect, test } from "bun:test"
import { renameSession } from "../../src/component/dialog-session-rename"

describe("renameSession", () => {
  // A refusal is the interesting case. `session.update` declares 400, 404 and
  // 500, and the client resolves them as `{data: undefined, error}` rather than
  // rejecting, so the handler used to close the dialog as if it had succeeded:
  // the list kept the old name, nothing was said, and the only copy of the name
  // the user had just typed went with the closed dialog.
  test("a refused rename is reported and is not a success", async () => {
    const reported: string[] = []
    const ok = await renameSession({
      update: async () => ({ data: undefined, error: { data: { message: "session not found" } } }),
      title: "New name",
      report: (reason) => reported.push(reason),
    })
    expect(ok).toBe(false)
    expect(reported).toEqual(["session not found"])
  })

  test("a transport failure is reported rather than escaping unhandled", async () => {
    const reported: string[] = []
    const ok = await renameSession({
      update: async () => {
        throw new Error("connection refused")
      },
      title: "New name",
      report: (reason) => reported.push(reason),
    })
    expect(ok).toBe(false)
    expect(reported).toEqual(["connection refused"])
  })

  test("a successful rename reports nothing and succeeds", async () => {
    const reported: string[] = []
    const seen: string[] = []
    const ok = await renameSession({
      update: async (title) => {
        seen.push(title)
        return { data: true }
      },
      title: "New name",
      report: (reason) => reported.push(reason),
    })
    expect(ok).toBe(true)
    expect(reported).toEqual([])
    // The typed title is what reaches the server.
    expect(seen).toEqual(["New name"])
  })

  test("the rename is awaited before the verdict is returned", async () => {
    let settled = false
    const ok = await renameSession({
      update: async () => {
        await Bun.sleep(5)
        settled = true
        return { data: true }
      },
      title: "New name",
      report: () => {},
    })
    expect(settled).toBe(true)
    expect(ok).toBe(true)
  })
})
