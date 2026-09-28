import { describe, expect, test } from "bun:test"
import { mergeCatalogList, readCatalogList } from "@/cli/cmd/run/catalog"

// A failed catalog read used to arrive as `[]`, which the footer could not tell
// from a genuinely empty catalog. So a transient error silently emptied the
// agent picker, the `@` resources and the `/` commands — including the user's
// installed skills — and the empty state then persisted, because the catalog is
// a one-time snapshot rather than a query that retries.

describe("readCatalogList", () => {
  // The generated client resolves typed failures into `.error` rather than
  // rejecting, so this is the branch a 404/500/timeout actually takes.
  test("reports a failed read as unknown, not as empty", () => {
    expect(readCatalogList({ data: undefined, error: { data: { message: "boom" } } }, [])).toBeUndefined()
  })

  test("returns the data when the read succeeded", () => {
    expect(readCatalogList({ data: ["a"] }, [])).toEqual(["a"])
  })

  test("treats a successful but empty read as empty, not unknown", () => {
    expect(readCatalogList({ data: [] }, ["stale"])).toEqual([])
  })

  test("falls back when a successful read carried no data", () => {
    expect(readCatalogList({ data: undefined }, ["fallback"])).toEqual(["fallback"])
  })

  test("handles a missing response", () => {
    expect(readCatalogList(undefined, [])).toBeUndefined()
  })
})

describe("mergeCatalogList", () => {
  test("keeps the previous list when the read failed", () => {
    expect(mergeCatalogList(["build"], undefined)).toEqual(["build"])
  })

  test("replaces the list when the read succeeded", () => {
    expect(mergeCatalogList(["build"], ["plan"])).toEqual(["plan"])
  })

  test("accepts a genuinely empty catalog as empty", () => {
    expect(mergeCatalogList(["build"], [])).toEqual([])
  })

  // The partial case: one list reloaded while another failed.
  test("applies a partial catalog without blanking the rest", () => {
    const previous = { agents: ["build"], commands: ["init"] }
    const next = { agents: [], commands: undefined }
    expect({
      agents: mergeCatalogList(previous.agents, next.agents),
      commands: mergeCatalogList(previous.commands, next.commands),
    }).toEqual({ agents: [], commands: ["init"] })
  })
})
