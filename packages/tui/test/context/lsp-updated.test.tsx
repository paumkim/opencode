/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mount, wait, json, worktree } from "../cli/cmd/tui/sync-fixture"
import type { FetchHandler } from "../fixture/tui-sdk"

const connected = [
  { id: "tsserver", root: worktree, status: "connected" },
  { id: "ruff", root: worktree, status: "error" },
]

// The `lsp.updated` push handler re-reads `lsp.status` whenever the server says
// the set of language servers changed. That read ended in `x.data ?? []`, and
// because the generated client resolves a non-2xx as `{data: undefined, error}`
// instead of rejecting, a failed refresh produced `[]` — indistinguishable from
// "every language server went away". A transient blip mid-session, with the user
// mid-keystroke, silently emptied the list.
test("a successful lsp.updated refresh replaces the list", async () => {
  let lspCalls = 0
  const override: FetchHandler = (url) => {
    if (url.pathname === "/lsp") return json(++lspCalls === 1 ? connected : [])
    return undefined
  }
  const { app, emit, sync } = await mount(override)
  try {
    await wait(() => sync.data.lsp.length === 2)
    emit({ directory: worktree, payload: { id: crypto.randomUUID(), type: "lsp.updated", properties: {} } })
    await wait(() => sync.data.lsp.length === 0)
    expect(sync.data.unreadable.lsp).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("a failed lsp.updated refresh keeps the known servers", async () => {
  let lspCalls = 0
  const override: FetchHandler = (url) => {
    if (url.pathname === "/lsp") {
      lspCalls++
      // First read succeeds and populates the list; the refresh that follows the
      // event is the one that fails.
      if (lspCalls === 1) return json(connected)
      return json({ name: "InstanceLoadError", data: { message: "boom", directory: worktree } }, { status: 500 })
    }
    return undefined
  }
  const { app, emit, sync } = await mount(override)
  try {
    await wait(() => sync.data.lsp.length === 2)
    emit({ directory: worktree, payload: { id: crypto.randomUUID(), type: "lsp.updated", properties: {} } })
    await wait(() => sync.data.unreadable.lsp !== undefined)

    // The servers the server told us about are still there, and the failure is
    // recorded rather than rendered as "no language servers".
    expect(sync.data.lsp.map((item) => item.id)).toEqual(["tsserver", "ruff"])
    expect(sync.data.unreadable.lsp).toContain("boom")
  } finally {
    app.renderer.destroy()
  }
})
