/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { createStore } from "solid-js/store"
import type { McpStatus, LspStatus } from "@opencode-ai/sdk/v2"
import { DialogStatus } from "../../src/component/dialog-status"

const dialog = await import("../../src/ui/dialog")
const sync = await import("../../src/context/sync")
const theme = await import("../../src/context/theme")

type Unreadable = {
  session?: string
  command?: string
  lsp?: string
  mcp?: string
  mcp_resource?: string
  formatter?: string
  session_status?: string
  provider_auth?: string
  vcs?: string
}

// Renders the real DialogStatus against a controlled store, so the assertions
// are about what the user actually sees rather than about the store contents.
async function frame(input: { mcp: Record<string, McpStatus>; unreadable: Unreadable; formatter?: string[] }) {
  const color = RGBA.fromHex("#ffffff")
  const [data, setData] = createStore({
    config: { plugin: [] },
    mcp: input.mcp,
    lsp: [] as LspStatus[],
    formatter: (input.formatter ?? []).map((name) => ({ name, enabled: true })),
    unreadable: input.unreadable,
  })
  const mocks = [
    spyOn(dialog, "useDialog").mockReturnValue({ clear() {} } as unknown as ReturnType<typeof dialog.useDialog>),
    spyOn(sync, "useSync").mockReturnValue({
      data,
    } as unknown as ReturnType<typeof sync.useSync>),
    spyOn(theme, "useTheme").mockReturnValue({
      theme: {
        text: color,
        textMuted: color,
        warning: RGBA.fromHex("#ffcc00"),
        success: color,
        error: color,
      },
    } as unknown as ReturnType<typeof theme.useTheme>),
  ]
  let app: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    app = await testRender(() => <DialogStatus />, { width: 80, height: 24 })
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app?.renderer.destroy()
    for (const mock of mocks) mock.mockRestore()
  }
}

test("an empty MCP status is reported as empty", async () => {
  const text = await frame({ mcp: {}, unreadable: {} })
  expect(text).toContain("No MCP Servers")
  expect(text).not.toContain("unavailable")
})

test("a connected MCP server is listed with its count", async () => {
  const text = await frame({
    mcp: { github: { status: "connected" } as McpStatus },
    unreadable: {},
  })
  expect(text).toContain("1 MCP Servers")
  expect(text).toContain("github")
  expect(text).toContain("Connected")
})

// The regression this pins: a `mcp.status` read that never landed used to land
// as `{}`, and this dialog then told the user they had no MCP servers at all.
test("a failed MCP read says unavailable, not 'no servers'", async () => {
  const text = await frame({ mcp: {}, unreadable: { mcp: "connection refused" } })
  expect(text).toContain("MCP Servers unavailable: connection refused")
  expect(text).not.toContain("No MCP Servers")
})

test("a failed formatter read says unavailable, not 'no formatters'", async () => {
  const text = await frame({ mcp: {}, unreadable: { formatter: "ETIMEDOUT" } })
  expect(text).toContain("Formatters unavailable: ETIMEDOUT")
  expect(text).not.toContain("No Formatters")
})

test("one failed capability does not hide the others", async () => {
  const text = await frame({
    mcp: { github: { status: "connected" } as McpStatus },
    unreadable: { formatter: "ETIMEDOUT" },
  })
  expect(text).toContain("1 MCP Servers")
  expect(text).toContain("Formatters unavailable: ETIMEDOUT")
})

// Five of the nine recorded failures had no reader at all. A failed
// `session.status` read in particular leaves a running background subagent
// displaying as stopped, because the code requires a defined status before
// treating one as anything but idle — and a failed `command.list` removes
// slash-command completion. Both were invisible.
test("a failed session.status read is reported", async () => {
  const text = await frame({ mcp: {}, unreadable: { session_status: "connection refused" } })
  expect(text).toContain("Could not read")
  expect(text).toContain("Session status: connection refused")
})

test("a failed command read is reported", async () => {
  const text = await frame({ mcp: {}, unreadable: { command: "timed out" } })
  expect(text).toContain("Custom commands: timed out")
})

test("every unread key is reported, not a hand-picked few", async () => {
  const text = await frame({
    mcp: {},
    unreadable: {
      command: "e1",
      mcp_resource: "e2",
      session_status: "e3",
      provider_auth: "e4",
      vcs: "e5",
    },
  })
  for (const label of [
    "Custom commands: e1",
    "MCP resources: e2",
    "Session status: e3",
    "Provider auth methods: e4",
    "Branch: e5",
  ]) {
    expect(text).toContain(label)
  }
})

// mcp/lsp/formatter already have their own sections, and the session read is
// shown in the session list dialog, so none of them should be listed twice.
test("reads with their own section are not listed twice", async () => {
  const text = await frame({
    mcp: {},
    unreadable: { mcp: "mcp failed", lsp: "lsp failed", formatter: "fmt failed", session: "session failed" },
  })
  expect(text).toContain("MCP Servers unavailable: mcp failed")
  expect(text).toContain("LSP Servers unavailable: lsp failed")
  expect(text).toContain("Formatters unavailable: fmt failed")
  expect(text).not.toContain("Could not read")
})
