/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2"
import { createStore } from "solid-js/store"
import { SubagentFooter } from "../../src/routes/session/subagent-footer"
import { SPINNER_FRAMES } from "../../src/component/spinner"

const route = await import("../../src/context/route")
const sync = await import("../../src/context/sync")
const theme = await import("../../src/context/theme")
const kv = await import("../../src/context/kv")
const keymap = await import("../../src/keymap")

for (const animations of [true, false]) {
  test(`subagent footer follows selected child status (animations: ${animations})`, async () => {
    const [selected, select] = createStore({ type: "session" as const, sessionID: "child-a" })
    const [data, setData] = createStore({
      session: ["child-a", "child-b"].map((id, index): Session => ({
        id,
        title: `@${index === 0 ? "general" : "explore"} subagent`,
        parentID: "parent",
        slug: id,
        projectID: "project",
        directory: "/tmp/opencode",
        version: "test",
        time: { created: index, updated: index },
      })),
      session_status: {} as Record<string, SessionStatus | undefined>,
      message: {},
      provider: [],
    })
    const color = RGBA.fromHex("#ffffff")
    // Replace surrounding contexts only; exercise the real footer, Spinner, and renderer.
    const mocks = [
      spyOn(route, "useRouteData").mockReturnValue(selected),
      spyOn(sync, "useSync").mockReturnValue({
        data,
        session: { get: (id: string) => data.session.find((item) => item.id === id) },
      } as unknown as ReturnType<typeof sync.useSync>),
      spyOn(theme, "useTheme").mockReturnValue({
        theme: { text: color, textMuted: color, border: color, backgroundPanel: RGBA.fromHex("#111111") },
      } as ReturnType<typeof theme.useTheme>),
      spyOn(kv, "useKV").mockReturnValue({ get: () => animations } as unknown as ReturnType<typeof kv.useKV>),
      spyOn(keymap, "useOpencodeKeymap").mockReturnValue({
        dispatchCommand() {},
      } as unknown as ReturnType<typeof keymap.useOpencodeKeymap>),
      spyOn(keymap, "useCommandShortcut").mockImplementation((command) => () =>
        command === "session.parent" ? "up" : command === "session.child.previous" ? "left" : "right",
      ),
    ]
    let app: Awaited<ReturnType<typeof testRender>> | undefined
    try {
      app = await testRender(() => <SubagentFooter />, { width: 100, height: 5 })
      const rendered = app
      async function frame(label: string, working: boolean) {
        await rendered.renderOnce()
        const text = rendered.captureCharFrame()
        expect(text).toContain(label)
        expect(text).toContain("Parent up")
        expect(text).toContain("Prev left")
        expect(text).toContain("Next right")
        expect(SPINNER_FRAMES.some((glyph) => text.includes(glyph))).toBe(working && animations)
        expect(text.includes("⋯")).toBe(working && !animations)
        return text
      }

      // Missing status is idle; another session's activity must not leak into this footer.
      await frame("General (1 of 2)", false)
      setData("session_status", "parent", { type: "busy" })
      setData("session_status", "child-b", { type: "busy" })
      await frame("General (1 of 2)", false)
      setData("session_status", "child-a", { type: "busy" })
      const busy = await frame("General (1 of 2)", true)
      if (animations) {
        const frames = new Set([busy])
        for (let i = 0; i < 5; i++) {
          await Bun.sleep(90)
          frames.add(await frame("General (1 of 2)", true))
        }
        expect(frames.size).toBeGreaterThan(1)
      }
      setData("session_status", "child-a", { type: "retry", attempt: 1, message: "Retry", next: 0 })
      await frame("General (1 of 2)", true)
      setData("session_status", "child-a", { type: "idle" })
      await frame("General (1 of 2)", false)
      select("sessionID", "child-b")
      await frame("Explore (2 of 2)", true)
      select("sessionID", "child-a")
      await frame("General (1 of 2)", false)
      setData("session_status", "child-a", undefined)
      await frame("General (1 of 2)", false)
    } finally {
      app?.renderer.destroy()
      for (const mock of mocks) mock.mockRestore()
    }
  })
}
