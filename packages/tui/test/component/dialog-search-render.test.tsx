/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { onCleanup } from "solid-js"
import { DialogSearch } from "../../src/routes/session/dialog-search"
import { resolve, TuiConfigProvider } from "../../src/config"
import { TuiKeybind } from "../../src/config/keybind"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"

const theme = await import("../../src/context/theme")
const dialog = await import("../../src/ui/dialog")
const sdk = await import("../../src/context/sdk")
const themes = await import("../../src/theme")

const hit = (over: Record<string, unknown> = {}) => ({
  sessionID: "ses_a",
  sessionTitle: "deploy notes",
  directory: "/repo",
  messageID: "msg_1",
  partID: "prt_1",
  role: "user",
  time: 1_700_000_000_000,
  matches: 1,
  snippet: "rotate the database password",
  snippetStart: 0,
  ...over,
})

/**
 * Renders the real dialog against a stubbed server, so a row is only on screen
 * because the request it came from was made and its answer was rendered. The
 * filter box is driven with real keystrokes, which is the only way the search
 * term reaches the request.
 */
async function mount(search: (query: { q: string }) => Promise<{ data: unknown[] }>) {
  const calls: { q: string }[] = []
  const selected: { sessionID: string; messageID: string }[] = []

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
          <DialogSearch all onSelect={(target) => selected.push(target)} />
        </OpencodeKeymapProvider>
      </TuiConfigProvider>
    )
  }

  const mocks = [
    spyOn(theme, "useTheme").mockReturnValue({
      theme: themes.resolveTheme(themes.DEFAULT_THEMES.opencode, "dark"),
    } as unknown as ReturnType<typeof theme.useTheme>),
    spyOn(dialog, "useDialog").mockReturnValue({
      clear() {},
      setSize() {},
    } as unknown as ReturnType<typeof dialog.useDialog>),
    spyOn(sdk, "useSDK").mockReturnValue({
      client: {
        session: {
          search: (input: { q: string }) => {
            calls.push(input)
            return search(input)
          },
        },
      },
    } as unknown as ReturnType<typeof sdk.useSDK>),
  ]
  const app = await testRender(() => <Harness />, { width: 100, height: 24 })
  await app.renderOnce()
  return {
    calls,
    selected,
    frame: () => app.captureCharFrame(),
    async type(text: string) {
      // The filter box autofocuses on mount. Without a beat for that, the first
      // keystroke is swallowed by the input that is not focused yet.
      await app.renderOnce()
      await Bun.sleep(60)
      await app.mockInput.typeText(text, 10)
      // The filter is debounced at 200ms before it reaches the server.
      await Bun.sleep(320)
      await app.renderOnce()
    },
    async dispose() {
      app.renderer.destroy()
      for (const mock of mocks) mock.mockRestore()
    },
  }
}

test("the dialog asks the server for what the user typed and shows the answer", async () => {
  const ui = await mount(async () => ({ data: [hit()] }))
  try {
    // Nothing is searched before a term is typed: a blank query would resolve to
    // an empty list, and a spinner that always resolves to nothing is a dead menu.
    expect(ui.calls).toEqual([])

    await ui.type("rotate the database")

    expect(ui.calls.length).toBeGreaterThan(0)
    expect(ui.calls.at(-1)!.q).toBe("rotate the database")
    const frame = ui.frame()
    expect(frame).toContain("rotate the database password")
    expect(frame).toContain("deploy notes")
  } finally {
    await ui.dispose()
  }
})

test("no matches says so instead of showing an empty list", async () => {
  const ui = await mount(async () => ({ data: [] }))
  try {
    await ui.type("nothing here")
    expect(ui.frame()).toContain("No messages match")
  } finally {
    await ui.dispose()
  }
})

test("an empty result is not reported as a search that found something", async () => {
  const ui = await mount(async () => ({ data: [] }))
  try {
    const before = ui.frame()
    expect(before).not.toContain("No messages match")
    expect(before).toContain("Search all sessions")
  } finally {
    await ui.dispose()
  }
})

test("a server that is down reads as no results rather than an empty dialog", async () => {
  const ui = await mount(async () => {
    throw new Error("server gone")
  })
  try {
    await ui.type("anything")
    expect(ui.frame()).toContain("No messages match")
  } finally {
    await ui.dispose()
  }
})
