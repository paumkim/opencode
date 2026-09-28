import { describe, expect, test } from "bun:test"
import { openEveryClient } from "@/lsp/lsp"
import { DiagnosticPullFailed, noReport } from "@/lsp/client"
import type * as LSPClient from "@/lsp/client"

function client(id: string) {
  return { serverID: id } as unknown as LSPClient.Info
}

describe("a diagnostics pull that could not be completed", () => {
  test("a pull failure is reported rather than read as a file with no errors", async () => {
    // The regression. `requestDiagnosticReport` caught its timeout into `.catch(() => null)`, and
    // `null` was also the server's real answer for "no diagnostics". The two collapsed into
    // `handled: false`, `waitForDocumentDiagnostics` exhausted its timeout, the caller read an empty
    // diagnostics map, and `tool/write.ts` returned "Wrote file successfully." for a file that had
    // errors in it. A missing measurement and a clean measurement must not be the same value.
    const reported: string[] = []
    await openEveryClient(
      [client("typescript")],
      "/repo/src/a.ts",
      "document",
      (m) => reported.push(m),
      async () => {
        throw new DiagnosticPullFailed("textDocument/diagnostic: request timed out after 2000ms")
      },
    )
    expect(reported).toHaveLength(1)
    // The consequence, stated so a reader knows what to do about it.
    expect(reported[0]).toContain("missing rather than clean")
    expect(reported[0]).toContain("typescript")
    expect(reported[0]).toContain("timed out")
  })

  test("the failure names the request method, so a reader knows which pull failed", async () => {
    const reported: string[] = []
    await openEveryClient(
      [client("clangd")],
      "/repo/b.cpp",
      "full",
      (m) => reported.push(m),
      async () => {
        throw new DiagnosticPullFailed("workspace/diagnostic (clang-tidy): connection closed")
      },
    )
    expect(reported[0]).toContain("workspace/diagnostic")
    expect(reported[0]).toContain("clang-tidy")
    expect(reported[0]).toContain("connection closed")
  })

  test("a server that answers with no diagnostics stays silent", async () => {
    // The direction that must not regress. `null` is a real answer from a server that has nothing to
    // report; treating it as a failure would turn every clean file into a log line, which is how a
    // fix starts manufacturing noise.
    const reported: string[] = []
    await openEveryClient(
      [client("ruff")],
      "/repo/c.py",
      "document",
      (m) => reported.push(m),
      async () => undefined,
    )
    expect(reported).toEqual([])
  })

  test("an open that succeeds and a pull that times out is reported once, naming only the pull", async () => {
    // A pull timeout is not an open failure, and conflating them sends whoever reads the log looking
    // for a server that never started when the server is up and merely slow.
    const reported: string[] = []
    await openEveryClient(
      [client("gopls")],
      "/repo/d.go",
      "document",
      (m) => reported.push(m),
      async () => {
        throw new DiagnosticPullFailed("textDocument/diagnostic: request timed out")
      },
    )
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain("could not produce diagnostics")
    expect(reported[0]).not.toContain("failed to open")
  })
})

describe("noReport", () => {
  // This is the decision the old `.catch(() => null)` erased, tested directly: the inject-a-throwing-
  // client tests above pass against the old code, because they replace the very code under test.
  test("a pull that could not be completed is a missing measurement, not a clean file", () => {
    const result = noReport("textDocument/diagnostic", undefined, new DiagnosticPullFailed("request timed out"))
    expect(result.failed).toContain("textDocument/diagnostic")
    expect(result.failed).toContain("request timed out")
    expect(result.handled).toBe(false)
    expect(result.matched).toBe(false)
  })

  test("the report names the identifier, so a reader knows which pull failed", () => {
    const result = noReport("workspace/diagnostic", "clang-tidy", new DiagnosticPullFailed("connection closed"))
    expect(result.failed).toContain("workspace/diagnostic (clang-tidy)")
    expect(result.failed).toContain("connection closed")
  })

  test("a structured failure is described rather than rendered as an object", () => {
    // The server's error payload is arbitrary data. `String(error)` on one yields "[object Object]"
    // and the report would name no reason at all, which is the defect the whole change exists to
    // remove.
    const result = noReport("textDocument/diagnostic", undefined, new DiagnosticPullFailed({ message: "server busy" }))
    expect(result.failed).toContain("server busy")
    expect(result.failed).not.toContain("[object Object]")
  })
})
