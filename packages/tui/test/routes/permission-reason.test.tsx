/** @jsxImportSource @opentui/solid */
import { describe, expect, spyOn, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { onCleanup } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { PermissionPrompt, describeAsk } from "../../src/routes/session/permission"
import { resolve, TuiConfigProvider } from "../../src/config"
import { TuiKeybind } from "../../src/config/keybind"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"

const theme = await import("../../src/context/theme")
const dialog = await import("../../src/ui/dialog")
const sdk = await import("../../src/context/sdk")
const sync = await import("../../src/context/sync")
const project = await import("../../src/context/project")
const pathFormat = await import("../../src/context/path-format")
const toast = await import("../../src/ui/toast")
const shared = await import("../../src/context/shared-workspace")
const themes = await import("../../src/theme")

const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: "per_1",
  sessionID: "ses_1",
  permission: "bash",
  patterns: ["rm -rf /"],
  metadata: {},
  always: [],
  ...over,
})

type Reason = NonNullable<PermissionRequest["matched"]>

const matched = (index: number, total: number, pattern = "rm*"): Reason => [
  { pattern: "rm -rf /", rule: { permission: "bash", action: "ask", pattern }, index, total },
]

const defaultAsk: Reason = [
  { pattern: "ls", rule: { permission: "bash", action: "ask", pattern: "*" }, index: -1, total: 3 },
]

describe("describeAsk", () => {
  test("names the rule and where it sits in the ruleset", () => {
    expect(describeAsk(matched(63, 87))).toBe("Rule 64/87 (bash = ask)")
  })

  test("drops a pattern that is the default one, which says nothing", () => {
    expect(describeAsk(matched(0, 1, "*"))).toBe("Rule 1/1 (bash = ask)")
  })

  test("says the question was not covered at all, which is the common case", () => {
    expect(describeAsk(defaultAsk)).toBe("no rule covers this, so it defaults to ask")
  })

  test("stays silent when the server sent no reason, rather than inventing one", () => {
    expect(describeAsk(undefined)).toBeUndefined()
    expect(describeAsk([])).toBeUndefined()
  })
})

/**
 * Renders the real prompt with a stubbed server, so the reason line is only on
 * screen because it came from the request the server would have sent.
 */
async function mount(input: PermissionRequest) {
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const keybinds = TuiKeybind.parse({})
    const config = {
      keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
        commandMap: TuiKeybind.CommandMap,
        bindingDefaults: TuiKeybind.bindingDefaults(),
      }),
      leader_timeout: 2000,
    }
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <TuiConfigProvider config={resolve({}, { terminalSuspend: true })}>
        <OpencodeKeymapProvider keymap={keymap}>
          <PermissionPrompt request={input} />
        </OpencodeKeymapProvider>
      </TuiConfigProvider>
    )
  }

  const mocks = [
    spyOn(theme, "useTheme").mockReturnValue({
      theme: themes.resolveTheme(themes.DEFAULT_THEMES.opencode, "dark"),
    } as unknown as ReturnType<typeof theme.useTheme>),
    spyOn(dialog, "useDialog").mockReturnValue({ clear() {} } as unknown as ReturnType<typeof dialog.useDialog>),
    spyOn(sync, "useSync").mockReturnValue({
      data: { session: [], unreadable: {} },
    } as unknown as ReturnType<typeof sync.useSync>),
    spyOn(sdk, "useSDK").mockReturnValue({
      client: { permission: { reply: async () => ({}) } },
    } as unknown as ReturnType<typeof sdk.useSDK>),
    spyOn(project, "useProject").mockReturnValue({
      data: { all: [], unreadable: {} },
    } as unknown as ReturnType<typeof project.useProject>),
    spyOn(pathFormat, "usePathFormatter").mockReturnValue({
      format: (value: string) => value,
    } as unknown as ReturnType<typeof pathFormat.usePathFormatter>),
    spyOn(toast, "useToast").mockReturnValue({
      show: () => {},
    } as unknown as ReturnType<typeof toast.useToast>),
    spyOn(shared, "useOptionalSharedWorkspace").mockReturnValue(
      undefined as unknown as ReturnType<typeof shared.useOptionalSharedWorkspace>,
    ),
  ]
  const app = await testRender(() => <Harness />, { width: 100, height: 30 })
  await app.renderOnce()
  return {
    frame: () => app.captureCharFrame(),
    async dispose() {
      app.renderer.destroy()
      for (const mock of mocks) mock.mockRestore()
    },
  }
}

test("the prompt names the rule that stopped the agent", async () => {
  const ui = await mount(request({ matched: matched(63, 87) }))
  try {
    const frame = ui.frame()
    expect(frame).toContain("Permission required")
    expect(frame).toContain("because")
    expect(frame).toContain("Rule 64/87 (bash = ask)")
  } finally {
    await ui.dispose()
  }
})

test("the prompt says when nothing in the config covered the question", async () => {
  const ui = await mount(
    request({
      matched: [{ pattern: "ls", rule: { permission: "bash", action: "ask", pattern: "*" }, index: -1, total: 3 }],
    }),
  )
  try {
    expect(ui.frame()).toContain("no rule covers this, so it defaults to ask")
  } finally {
    await ui.dispose()
  }
})

test("the prompt still renders when the server sent no reason", async () => {
  const ui = await mount(request())
  try {
    const frame = ui.frame()
    expect(frame).toContain("Permission required")
    expect(frame).not.toContain("because")
  } finally {
    await ui.dispose()
  }
})
