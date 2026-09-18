/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { createSignal } from "solid-js"
import path from "node:path"
import { GoalBar } from "../../src/component/prompt/goal-bar"
import { tmpdir } from "../fixture/fixture"

const theme = await import("../../src/context/theme")
const event = await import("../../src/context/event")
const sdk = await import("../../src/context/sdk")
const sync = await import("../../src/context/sync")
const dialog = await import("../../src/ui/dialog")

type Goal = { sessionID?: string; status: string; objective: string; createdAt: number }
const goal = (sessionID?: string, status = "active"): Goal => ({
  sessionID,
  status,
  objective: "Fixture goal, never user state",
  createdAt: 1,
})

// Mock only surrounding contexts; render the real component and read real temp JSON.
async function mount(goals: Goal[], sessionID?: string, keyed = false) {
  const tmp = await tmpdir()
  const previous = process.env.OPENCODE_GOAL_STATE_PATH
  const listeners = new Map<string, () => void>()
  const mocks = [
    spyOn(theme, "useTheme").mockReturnValue({
      theme: { success: RGBA.fromHex("#00ff00"), warning: RGBA.fromHex("#ffff00") },
    } as ReturnType<typeof theme.useTheme>),
    spyOn(event, "useEvent").mockReturnValue({
      on(type: string, handler: () => void) {
        listeners.set(type, handler)
        return () => {
          listeners.delete(type)
        }
      },
    } as ReturnType<typeof event.useEvent>),
    spyOn(sdk, "useSDK").mockReturnValue({} as ReturnType<typeof sdk.useSDK>),
    spyOn(sync, "useSync").mockReturnValue({ data: { command: [] } } as unknown as ReturnType<typeof sync.useSync>),
    spyOn(dialog, "useDialog").mockReturnValue({} as ReturnType<typeof dialog.useDialog>),
  ]
  const [session, setSession] = createSignal(sessionID)
  let app: Awaited<ReturnType<typeof testRender>> | undefined
  async function cleanup() {
    app?.renderer.destroy()
    for (const mock of mocks) mock.mockRestore()
    if (previous === undefined) delete process.env.OPENCODE_GOAL_STATE_PATH
    else process.env.OPENCODE_GOAL_STATE_PATH = previous
    await tmp[Symbol.asyncDispose]()
  }
  try {
    process.env.OPENCODE_GOAL_STATE_PATH = path.join(tmp.path, "goals.json")
    await Bun.write(
      process.env.OPENCODE_GOAL_STATE_PATH,
      JSON.stringify({ goals: keyed ? Object.fromEntries(goals.map((g, i) => [String(i), g])) : goals }),
    )
    app = await testRender(() => <GoalBar sessionID={session()} />, { width: 40, height: 3 })
    const rendered = app
    return {
      setSession,
      listeners,
      async frame() {
        // The component loads on mount and on events, asynchronously from disk.
        await Bun.sleep(30)
        await rendered.renderOnce()
        return rendered.captureCharFrame().trim()
      },
      async [Symbol.asyncDispose]() {
        await cleanup()
        expect(listeners.size).toBe(0)
      },
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

for (const keyed of [false, true]) {
  test(`GoalBar hides stored active goals without a session (${keyed ? "map" : "array"})`, async () => {
    await using view = await mount([goal("session-a"), goal()], undefined, keyed)
    expect(await view.frame()).toBe("")
    // Positive control: prove this fixture is loadable, not blank due to an import/read failure.
    view.setSession("session-a")
    view.listeners.get("session.status")!()
    expect(await view.frame()).toContain("Goal active")
  })
}

test("GoalBar hides a different session and unscoped records", async () => {
  await using view = await mount([goal("session-a"), goal()], "session-b")
  expect(await view.frame()).toBe("")
  view.setSession("session-a")
  view.listeners.get("message.updated")!()
  expect(await view.frame()).toContain("Goal active")
})

test("GoalBar does not let an unscoped active goal override a matching paused goal", async () => {
  await using view = await mount([goal(), goal("session-a", "paused")], "session-a")
  expect(await view.frame()).toContain("Goal paused")
  expect(await view.frame()).not.toContain("Goal active")
})

for (const status of ["complete", "unmet", "done"]) {
  test(`GoalBar hides matching terminal status ${status}`, async () => {
    await using view = await mount([goal("session-a", status), goal("session-b")], "session-a")
    expect(await view.frame()).toBe("")
    view.setSession("session-b")
    view.listeners.get("session.status")!()
    expect(await view.frame()).toContain("Goal active")
  })
}

test("GoalBar refreshes session changes and clears on home after a status event", async () => {
  await using view = await mount([goal("session-a"), goal("session-b", "paused"), goal()], "session-a")
  expect(await view.frame()).toContain("Goal active")
  view.setSession("session-b")
  view.listeners.get("session.status")!()
  expect(await view.frame()).toContain("Goal paused")
  view.setSession("missing")
  view.listeners.get("session.status")!()
  expect(await view.frame()).toBe("")
  view.setSession(undefined)
  view.listeners.get("session.status")!()
  expect(await view.frame()).toBe("")
})
