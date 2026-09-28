import { describe, expect, test } from "bun:test"
import { requestOrFail } from "@/lsp/lsp"

// The behaviour every LSP request now has. A failed request used to resolve to
// `[]`/`null`, and the tool in src/tool/lsp.ts answers `No results found for
// <operation>` on an empty result — so a crashed language server was reported to
// the model as a confident falsehood about the user's own code.

const failing = (reason: unknown) => Promise.reject(reason)

describe("requestOrFail", () => {
  test("passes a successful result straight through", async () => {
    expect(await requestOrFail("hover", Promise.resolve({ contents: "x" }))).toEqual({ contents: "x" })
  })

  // The regression: previously this resolved to `[]` / `null`, and the tool
  // turned that into "No results found".
  test("rejects with the reason rather than resolving to an empty result", async () => {
    await expect(requestOrFail("findReferences", failing(new Error("server crashed")))).rejects.toThrow(
      "LSP findReferences request failed: server crashed",
    )
  })

  // A server that does not implement a request answers method-not-found. That
  // is still a failure, and the model can do something correct with it — unlike
  // with a silent empty list.
  test("keeps a method-not-found reason visible", async () => {
    await expect(
      requestOrFail("goToImplementation", failing({ code: -32601, message: "method not found" })),
    ).rejects.toThrow(/method not found/)
  })

  test("describes a non-Error rejection", async () => {
    await expect(requestOrFail("documentSymbol", failing("socket closed"))).rejects.toThrow(
      "LSP documentSymbol request failed: socket closed",
    )
  })
})

describe("the tool's answer for an empty result", () => {
  // The line the defect turned into a false statement: the tool answers this
  // whenever the result is empty, so a failed read must throw before it gets
  // there rather than resolve to an empty list.
  const toolOutput = (result: unknown[]) => (result.length === 0 ? "No results found" : JSON.stringify(result, null, 2))

  test("says No results found only for a genuinely empty successful read", () => {
    expect(toolOutput([])).toBe("No results found")
  })

  test("a failed read never produces that string", async () => {
    const reached = await requestOrFail("findReferences", failing(new Error("boom"))).then(
      () => "resolved",
      () => "threw",
    )
    expect(reached).toBe("threw")
  })
})
