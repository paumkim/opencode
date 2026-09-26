/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { onCleanup } from "solid-js"
import { DialogSelect } from "../../src/ui/dialog-select"
import { resolve, TuiConfigProvider } from "../../src/config"
import { TuiKeybind } from "../../src/config/keybind"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"

const theme = await import("../../src/context/theme")
const dialog = await import("../../src/ui/dialog")
const themes = await import("../../src/theme")

// Renders the real DialogSelect with the smallest provider set it needs
// (config + keymap), and drives it with real mouse events.
async function mount(props: { singleClickConfirm?: boolean; requireConfirmClick?: boolean }) {
  const picked: string[] = []

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
          <DialogSelect
            title="Goal"
            renderFilter={false}
            skipFilter
            singleClickConfirm={props.singleClickConfirm}
            options={[
              { title: "Alpha", value: "alpha" },
              { title: "Danger", value: "danger", requireConfirmClick: props.requireConfirmClick },
            ]}
            onSelect={(option) => picked.push(option.value)}
          />
        </OpencodeKeymapProvider>
      </TuiConfigProvider>
    )
  }

  const mocks = [
    spyOn(theme, "useTheme").mockReturnValue({
      theme: themes.resolveTheme(themes.DEFAULT_THEMES.opencode, "dark"),
    } as unknown as ReturnType<typeof theme.useTheme>),
    spyOn(dialog, "useDialog").mockReturnValue({ clear() {} } as unknown as ReturnType<typeof dialog.useDialog>),
  ]
  const app = await testRender(() => <Harness />, { width: 60, height: 20 })
  await app.renderOnce()
  return {
    picked,
    async row(title: string) {
      const y = app.captureCharFrame().split("\n").findIndex((line) => line.includes(title))
      expect(y).toBeGreaterThanOrEqual(0)
      return y
    },
    async click(title: string) {
      await app.mockMouse.click(6, await this.row(title))
      await Bun.sleep(20)
    },
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      for (const mock of mocks) mock.mockRestore()
    },
  }
}

// The goal menu sets singleClickConfirm because a first click that only moves
// the highlight reads as a dead menu item. This is opt-in, so confirm it is
// actually wired and that the default is untouched.
test("DialogSelect still requires two clicks by default", async () => {
  await using view = await mount({})
  await view.click("Alpha")
  expect(view.picked).toEqual([])
  await view.click("Alpha")
  expect(view.picked).toEqual(["alpha"])
})

test("DialogSelect commits on a single click when singleClickConfirm is set", async () => {
  await using view = await mount({ singleClickConfirm: true })
  await view.click("Alpha")
  expect(view.picked).toEqual(["alpha"])
})

test("DialogSelect keeps the two-click confirm for a requireConfirmClick row", async () => {
  await using view = await mount({ singleClickConfirm: true, requireConfirmClick: true })
  await view.click("Danger")
  expect(view.picked).toEqual([])
  await view.click("Danger")
  expect(view.picked).toEqual(["danger"])
})
