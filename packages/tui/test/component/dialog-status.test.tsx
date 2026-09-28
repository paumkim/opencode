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
