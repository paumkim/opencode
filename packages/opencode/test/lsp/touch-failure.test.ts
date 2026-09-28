import { describe, expect, test } from "bun:test"
import { openEveryClient } from "@/lsp/lsp"
import type * as LSPClient from "@/lsp/client"

function client(id: string) {
  return { serverID: id } as unknown as LSPClient.Info
}

describe("openEveryClient", () => {
  test("one client failing does not discard the others' results, and it is reported", async () => {
    // The regression. The old code was `Promise.all(clients.map(...)).catch(() => {})`, so a single
    // client whose `didOpen` rejected took down every client's result with it. A file watched by
    // three language servers where one is down produced no diagnostics, and `tool/write.ts` then
    // reports plain "Wrote file successfully." - the agent is told the file is clean because one
    // server failed to open it.
    const reached: string[] = []
    const reported: string[] = []
    await openEveryClient(
      [client("typescript"), client("clangd"), client("ruff")],
      "/repo/src/a.ts",
      "document",
      (m) => reported.push(m),
      async (c) => {
        reached.push(c.serverID)
        if (c.serverID === "clangd") throw new Error("server exited")
        return "ok"
      },
    )

    // Every client was still attempted - that part was never the bug.
    expect(reached.sort()).toEqual(["clangd", "ruff", "typescript"])
    // And exactly one report, naming the server that failed, the file, and the reason.
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain("clangd")
    expect(reported[0]).toContain("/repo/src/a.ts")
    expect(reported[0]).toContain("server exited")
    // The consequence, which is what makes the report worth writing at all.
    expect(reported[0]).toContain("missing rather than clean")
  })

  test("reports every failure when several clients are down", async () => {
    const reported: string[] = []
    await openEveryClient(
      [client("a"), client("b"), client("c")],
      "/repo/x.py",
      "document",
      (m) => reported.push(m),
      async (c) => {
        if (c.serverID === "c") return "ok"
        throw new Error(`${c.serverID} down`)
      },
    )
    expect(reported).toHaveLength(2)
    expect(reported.some((m) => m.startsWith("[lsp] a "))).toBe(true)
    expect(reported.some((m) => m.startsWith("[lsp] b "))).toBe(true)
  })

  test("reports nothing when every client opens the file", async () => {
    const reported: string[] = []
    await openEveryClient(
      [client("typescript"), client("ruff")],
      "/repo/b.ts",
      "document",
      (m) => reported.push(m),
      async () => "ok",
    )
    expect(reported).toEqual([])
  })

  test("a successful result carrying client and error fields is not mistaken for a failure", async () => {
    // A client payload is arbitrary data. Deciding "did this fail?" by looking for a field named
    // `error` would report a perfectly good diagnostics payload as a failure, which is how a fix
    // starts manufacturing noise.
    const reported: string[] = []
    await openEveryClient(
      [client("weird")],
      "/repo/c.ts",
      "document",
      (m) => reported.push(m),
      async () => ({
        client: "not a client",
        error: "not a failure",
      }),
    )
    expect(reported).toEqual([])
  })

  test("passes the requested diagnostics mode and file through to each client", async () => {
    const calls: [string, string, string | undefined][] = []
    await openEveryClient(
      [client("a")],
      "/repo/d.go",
      "full",
      () => {},
      async (c, file, mode) => {
        calls.push([c.serverID, file, mode])
        return "ok"
      },
    )
    expect(calls).toEqual([["a", "/repo/d.go", "full"]])
  })

  test("never rejects, so one client cannot break the caller", async () => {
    // `touchFile` is awaited by tool/write, tool/edit and tool/apply_patch. A rejection here would
    // surface as a failed write for a problem that is only a language server being down.
    await openEveryClient(
      [client("a")],
      "/repo/e.ts",
      "document",
      () => {},
      async () => {
        throw new Error("everything is down")
      },
    )
  })
})
