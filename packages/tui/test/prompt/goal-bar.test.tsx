/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { createSignal } from "solid-js"
import path from "node:path"
import {
  GoalBar,
  goalMenuOptions,
  handleGoalAction,
  requestGoalEdit,
  requestGoalExtension,
  runGoalMenuCommand,
} from "../../src/component/prompt/goal-bar"
import { tmpdir } from "../fixture/fixture"

const theme = await import("../../src/context/theme")
const event = await import("../../src/context/event")
const sdk = await import("../../src/context/sdk")
const sync = await import("../../src/context/sync")
const dialog = await import("../../src/ui/dialog")
const toast = await import("../../src/ui/toast")
const prompt = await import("../../src/ui/dialog-prompt")

type Goal = { sessionID?: string; status: string; objective: string; createdAt: number; stopReason?: string }
// createdAt is in SECONDS, matching the goal plugin's persisted state.
const goal = (sessionID?: string, status = "active"): Goal => ({
  sessionID,
  status,
  objective: "Fixture goal, never user state",
  createdAt: Math.floor(Date.now() / 1000) - 60,
})

// Mock only surrounding contexts; render the real component and read real temp JSON.
async function mount(goals: Goal[], sessionID?: string, keyed = false, width = 40, interactive = false) {
  const tmp = await tmpdir()
  const previous = process.env.OPENCODE_GOAL_STATE_PATH
  const listeners = new Map<string, () => void>()
  // Interactive mounts capture dialog.replace so a real mouse click can be
  // asserted to open the menu; the non-interactive ones never click.
  const menus: unknown[] = []
  const dialogContext = interactive
    ? ({
        replace(element: unknown) {
          menus.push(element)
        },
        clear() {},
      } as unknown as ReturnType<typeof dialog.useDialog>)
    : ({} as ReturnType<typeof dialog.useDialog>)
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
    spyOn(dialog, "useDialog").mockReturnValue(dialogContext),
    spyOn(toast, "useToast").mockReturnValue({
      show() {},
      error() {},
    } as unknown as ReturnType<typeof toast.useToast>),
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
    app = await testRender(() => <GoalBar sessionID={session()} />, { width, height: 3 })
    const rendered = app
    return {
      setSession,
      listeners,
      menus,
      async frame() {
        // The component loads on mount and on events, asynchronously from disk.
        await Bun.sleep(30)
        await rendered.renderOnce()
        return rendered.captureCharFrame().trim()
      },
      async click(x: number, y: number) {
        await rendered.mockMouse.click(x, y)
        await Bun.sleep(20)
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

test("GoalBar submits the entered extension limits through the returned prompt value", async () => {
  const show = spyOn(prompt.DialogPrompt, "show").mockResolvedValue(" token_budget=1000 ")
  const commands: string[] = []
  try {
    await requestGoalExtension({} as ReturnType<typeof dialog.useDialog>, (command) => commands.push(command))
  } finally {
    show.mockRestore()
  }
  expect(commands).toEqual(["extend token_budget=1000"])
})

test("GoalBar keeps extension submission safe when the prompt is cancelled", async () => {
  const show = spyOn(prompt.DialogPrompt, "show").mockResolvedValue(null)
  const commands: string[] = []
  try {
    await requestGoalExtension({} as ReturnType<typeof dialog.useDialog>, (command) => commands.push(command))
  } finally {
    show.mockRestore()
  }
  expect(commands).toEqual([])
})

test("GoalBar shows the actual limited stop reason", async () => {
  await using view = await mount([{ ...goal("session-a", "usageLimited"), stopReason: "token budget reached" }], "session-a")
  expect(await view.frame()).toContain("oken budget r")
})

test("GoalBar tells a plan-mode-paused goal how to unblock", async () => {
  // A bare "Goal paused" hides the only action that resumes the goal, and the menu's
  // "Resume goal" row would then fail while the session is still in Plan mode.
  await using view = await mount([{ ...goal("session-a", "paused"), stopReason: "plan mode" }], "session-a", false, 80)
  const frame = await view.frame()
  expect(frame).toContain("Goal paused")
  expect(frame).toContain("Build mode")
})

test("GoalBar ignores an unknown status from the user-writable state file", async () => {
  await using view = await mount([{ ...goal("session-a", "totally-unknown") }], "session-a")
  expect(await view.frame()).toBe("")
})

test("GoalBar keeps the objective compact and truncates it on a narrow prompt", async () => {
  await using view = await mount([{ ...goal("session-a"), objective: "A very long objective that should be truncated in the compact one-line goal bar" }], "session-a")
  const frame = await view.frame()
  expect(frame).toContain("Goal active")
  expect(frame).toContain("very long obj…")
  expect(frame.split("\n")).toHaveLength(1)
  expect(frame.length).toBeLessThanOrEqual(40)
})

test("GoalBar does not let an unscoped active goal override a matching paused goal", async () => {
  await using view = await mount([goal(), goal("session-a", "paused")], "session-a")
  expect(await view.frame()).toContain("Goal paused")
  expect(await view.frame()).not.toContain("Goal active")
})

for (const status of ["complete", "unmet"]) {
  test(`GoalBar hides matching terminal status ${status}`, async () => {
    await using view = await mount([goal("session-a", status), goal("session-b")], "session-a")
    expect(await view.frame()).toBe("")
    view.setSession("session-b")
    view.listeners.get("session.status")!()
    expect(await view.frame()).toContain("Goal active")
  })
}

// Regression: the goal plugin stores createdAt in SECONDS. The bar used to subtract it
// from Date.now() (MILLISECONDS) directly, inflating elapsed time 1000x and rendering
// "~2957 weeks" for a goal a few minutes old. Elapsed only renders at width >= 60,
// so these render wide.
const WIDE = 100

test("GoalBar renders a sane duration for a seconds-based createdAt", async () => {
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 5 * 60
  await using view = await mount([{ ...goal("session-a"), createdAt: fiveMinutesAgo }], "session-a", false, WIDE)
  const frame = await view.frame()
  expect(frame).toContain("5m")
  expect(frame).not.toContain("weeks")
})

test("GoalBar renders a sane duration for a millisecond-based createdAt", async () => {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
  await using view = await mount([{ ...goal("session-a"), createdAt: fiveMinutesAgo }], "session-a", false, WIDE)
  const frame = await view.frame()
  expect(frame).toContain("5m")
  expect(frame).not.toContain("weeks")
})

test("GoalBar omits the duration for a bogus or future createdAt instead of rendering nonsense", async () => {
  // createdAt: 1 is seconds-since-epoch (1970) -> absurd age, and a future stamp is negative.
  for (const createdAt of [1, Math.floor(Date.now() / 1000) + 10_000]) {
    await using view = await mount([{ ...goal("session-a"), createdAt }], "session-a", false, WIDE)
    const frame = await view.frame()
    expect(frame).toContain("Goal active")
    expect(frame).not.toContain("weeks")
  }
})

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

// --- Menu actions -----------------------------------------------------------
//
// These drive the real exported menu logic. Previously openMenu's onSelect was
// unreachable from tests because the harness mocked useDialog as `{}` and
// useSync with an empty command list, so every item silently no-opped.

const emptyDialog = {} as ReturnType<typeof dialog.useDialog>

// Regression for the dead "Edit objective…" item: DialogPrompt.show resolves
// through its promise and drops an `onConfirm` passed in options, so the old
// caller-style callback never ran and the objective was never updated.
test("GoalBar edits the objective through the returned prompt value", async () => {
  const show = spyOn(prompt.DialogPrompt, "show").mockResolvedValue(" Ship the parser rewrite ")
  const commands: string[] = []
  try {
    await requestGoalEdit(emptyDialog, "Old objective", (command) => commands.push(command))
  } finally {
    show.mockRestore()
  }
  expect(commands).toEqual(["edit Ship the parser rewrite"])
})

test("GoalBar seeds the edit prompt with the current objective and sends no command on cancel", async () => {
  const show = spyOn(prompt.DialogPrompt, "show").mockResolvedValue(null)
  const commands: string[] = []
  try {
    await requestGoalEdit(emptyDialog, "Current objective", (command) => commands.push(command))
    expect(show).toHaveBeenCalledWith(emptyDialog, "Edit goal", {
      value: "Current objective",
      placeholder: "Goal objective",
    })
  } finally {
    show.mockRestore()
  }
  expect(commands).toEqual([])
})

test("GoalBar keeps an all-whitespace edit from clearing the objective", async () => {
  const show = spyOn(prompt.DialogPrompt, "show").mockResolvedValue("   ")
  const commands: string[] = []
  try {
    await requestGoalEdit(emptyDialog, "Current objective", (command) => commands.push(command))
  } finally {
    show.mockRestore()
  }
  expect(commands).toEqual([])
})

test("GoalBar dispatches the status, pause, and clear menu items", () => {
  const cases: [Parameters<typeof handleGoalAction>[0]["action"], string[]][] = [
    ["status", ["status"]],
    ["toggle", ["pause"]],
    ["clear", ["clear"]],
  ]
  for (const [action, expected] of cases) {
    const commands: string[] = []
    handleGoalAction({ action, dialog: emptyDialog, goal: goal(), runCommand: (c) => commands.push(c) })
    expect(commands).toEqual(expected)
  }
})

test("GoalBar resumes instead of pausing for a paused goal", () => {
  const commands: string[] = []
  handleGoalAction({
    action: "toggle",
    dialog: emptyDialog,
    goal: goal("session-a", "paused"),
    runCommand: (c) => commands.push(c),
  })
  expect(commands).toEqual(["resume"])
})

test("GoalBar routes the edit menu item through the awaited prompt value", async () => {
  const show = spyOn(prompt.DialogPrompt, "show").mockResolvedValue("New objective")
  const commands: string[] = []
  try {
    handleGoalAction({
      action: "edit",
      dialog: emptyDialog,
      goal: { ...goal(), objective: "Old objective" },
      runCommand: (c) => commands.push(c),
    })
    // handleGoalAction fires the prompt without awaiting it; let the microtask run.
    await Bun.sleep(10)
  } finally {
    show.mockRestore()
  }
  expect(commands).toEqual(["edit New objective"])
})

test("GoalBar offers extend limits only for a limited goal and toggles otherwise", () => {
  const limited = goalMenuOptions(goal("session-a", "budgetLimited"))
  expect(limited.map((o) => o.value)).toEqual(["status", "extend", "edit", "clear"])
  expect(limited.find((o) => o.value === "extend")!.title).toBe("Extend limits…")

  const active = goalMenuOptions(goal("session-a", "active"))
  expect(active.map((o) => o.value)).toEqual(["status", "toggle", "edit", "clear"])
  expect(active.find((o) => o.value === "toggle")!.title).toBe("Pause goal")

  const paused = goalMenuOptions(goal("session-a", "paused"))
  expect(paused.find((o) => o.value === "toggle")!.title).toBe("Resume goal")
})

test("GoalBar marks only the destructive clear row as needing a second click", () => {
  const options = goalMenuOptions(goal())
  const guarded = options.filter((o) => o.requireConfirmClick).map((o) => o.value)
  expect(guarded).toEqual(["clear"])
})

// --- Command dispatch feedback ---------------------------------------------

function dispatchHarness(overrides: Partial<Parameters<typeof runGoalMenuCommand>[0]> = {}) {
  const notices: { title: string; message: string; variant: string }[] = []
  const sent: { sessionID: string; command: string; arguments: string }[] = []
  let reported = false
  runGoalMenuCommand({
    args: "status",
    sessionID: "session-a",
    commandName: "goal",
    dispatch: (input) => {
      sent.push(input)
      return Promise.resolve({})
    },
    notify: (notice) => notices.push(notice),
    wasReported: () => reported,
    markReported: () => {
      reported = true
    },
    ...overrides,
  })
  return { notices, sent }
}

test("GoalBar sends the command when the goal plugin registered it", () => {
  const { notices, sent } = dispatchHarness()
  expect(sent).toEqual([{ sessionID: "session-a", command: "goal", arguments: "status" }])
  expect(notices).toEqual([])
})

test("GoalBar reports the unavailable command instead of silently doing nothing", () => {
  const { notices, sent } = dispatchHarness({ commandName: undefined })
  expect(sent).toEqual([])
  expect(notices).toHaveLength(1)
  expect(notices[0].variant).toBe("error")
  expect(notices[0].message).toContain("/goal")
})

test("GoalBar does not repeat the unavailable notice on every subsequent action", () => {
  // A fresh runner with the same reported-flag stands in for a second click
  // against the same bar, which shares one reported flag.
  let reported = false
  const notices: unknown[] = []
  const run = () =>
    runGoalMenuCommand({
      args: "status",
      sessionID: "session-a",
      commandName: undefined,
      dispatch: () => Promise.resolve({}),
      notify: (notice) => notices.push(notice),
      wasReported: () => reported,
      markReported: () => {
        reported = true
      },
    })
  run()
  run()
  run()
  expect(notices).toHaveLength(1)
})

test("GoalBar reports a missing session rather than dropping the action", () => {
  const { notices, sent } = dispatchHarness({ sessionID: undefined })
  expect(sent).toEqual([])
  expect(notices).toHaveLength(1)
  expect(notices[0].variant).toBe("error")
})

test("GoalBar surfaces a rejected goal command as an error toast", async () => {
  const notices: { title: string; message: string; variant: string }[] = []
  runGoalMenuCommand({
    args: "pause",
    sessionID: "session-a",
    commandName: "goal",
    dispatch: () => Promise.reject(new Error('Command not found: "goal".')),
    notify: (notice) => notices.push(notice),
    wasReported: () => false,
    markReported: () => {},
  })
  await Bun.sleep(10)
  expect(notices).toHaveLength(1)
  expect(notices[0].variant).toBe("error")
  expect(notices[0].message).toContain("Command not found")
})

test("GoalBar renders a clickable caret affordance on the one-row bar", async () => {
  await using view = await mount([goal("session-a")], "session-a", false, WIDE, true)
  const frame = await view.frame()
  expect(frame).toContain("▾")
  expect(frame.split("\n")).toHaveLength(1)

  // The caret is the affordance the user aims at, so clicking it must open the
  // menu exactly once (its own handler plus the row handler must not double-fire).
  const caretX = frame.split("\n")[0].indexOf("▾")
  expect(caretX).toBeGreaterThan(0)
  await view.click(caretX, 0)
  expect(view.menus).toHaveLength(1)

  // The rest of the row must stay clickable too.
  await view.click(2, 0)
  expect(view.menus).toHaveLength(2)
})
