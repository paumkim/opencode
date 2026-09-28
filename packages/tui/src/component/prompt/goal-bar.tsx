import { createMemo, createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { useTheme } from "../../context/theme"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useDialog, type DialogContext } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { useToast } from "../../ui/toast"
import { formatDuration } from "../../util/format"
import { errorMessage } from "../../util/error"
import { legacyStateFile, statePath } from "@opencode-ai/core/goal/path"

const GOAL_POLL_MS = 2_000
const DEFAULT_GOAL_COMMAND = "goal"

// Must stay in sync with GoalStatus in packages/opencode/src/goal/schema.ts.
type GoalStatus = "active" | "paused" | "budgetLimited" | "usageLimited" | "complete" | "unmet"

type Goal = {
  id?: string
  sessionID?: string
  objective?: string
  /**
   * Optional short label the model supplies for exactly this bar. Absent on every goal created
   * before the field existed, which is why the objective is still the fallback and not dead code.
   */
  title?: string
  text?: string
  status: GoalStatus | string
  createdAt: number | string
  updatedAt?: number | string
  stopReason?: string | null
}

function goalText(g: Goal): string {
  if (typeof g.objective === "string" && g.objective.trim()) return g.objective
  if (typeof g.text === "string" && g.text.trim()) return g.text
  return ""
}

/**
 * The short label, or "" when the goal has none. Trimmed, because this reads a user-writable state
 * file and a title of "   " must fall through to the objective rather than render as a blank row.
 */
function goalTitle(g: Goal): string {
  if (typeof g.title === "string" && g.title.trim()) return g.title.trim()
  return ""
}

// The goal plugin persists `createdAt` in SECONDS (impl.ts uses
// `Math.floor(Date.now() / 1000)`), while Date.now() is in MILLISECONDS.
// Subtracting the two directly inflates elapsed time by 1000x (a goal born a
// few minutes ago renders as "~2957 weeks"), so normalize to milliseconds
// first. Tolerates string values and already-millisecond timestamps.
const SECONDS_CUTOFF = 1e11 // 1e11ms is 1973; any real "now" in seconds is far below this
function toEpochMillis(value: number | string | undefined | null) {
  if (value == null) return Number.NaN
  const numeric = typeof value === "string" ? Number(value) : value
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return Number.NaN
  return numeric < SECONDS_CUTOFF ? numeric * 1000 : numeric
}

// Only in-progress goals render the bar. Terminal states (complete/unmet) stay hidden so the
// prompt keeps zero extra rows when there is no active goal (Kilo-like behavior).
const VISIBLE_STATUSES = new Set<GoalStatus>(["active", "paused", "budgetLimited", "usageLimited"])

const ALL_GOAL_STATUSES: ReadonlySet<string> = new Set<GoalStatus>([
  "active",
  "paused",
  "budgetLimited",
  "usageLimited",
  "complete",
  "unmet",
])

/** The persisted file is user-writable, so an unknown status must be ignored rather than rendered. */
function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === "string" && ALL_GOAL_STATUSES.has(value)
}

type GoalAction = "status" | "toggle" | "extend" | "edit" | "clear"

export async function requestGoalExtension(dialog: DialogContext, runCommand: (args: string) => void) {
  const value = await DialogPrompt.show(dialog, "Extend goal limits", {
    placeholder: "token_budget=1000000 max_duration_seconds=null",
  })
  if (value?.trim()) runCommand(`extend ${value.trim()}`)
}

// `DialogPrompt.show` resolves through the promise and IGNORES an `onConfirm`
// passed in `options` (its own handler is applied after the spread), so this
// must await the returned value — an options callback never fires.
export async function requestGoalEdit(
  dialog: DialogContext,
  objective: string,
  runCommand: (args: string) => void,
) {
  const value = await DialogPrompt.show(dialog, "Edit goal", {
    value: objective,
    placeholder: "Goal objective",
  })
  if (value?.trim()) runCommand(`edit ${value.trim()}`)
}

function isActiveGoal(goal: Goal) {
  return goal.status === "active"
}

function isLimitedGoal(goal: Goal) {
  return goal.status === "budgetLimited" || goal.status === "usageLimited"
}

// Exported for tests: the menu contents are a pure function of the goal status.
export function goalMenuOptions(goal: Goal): DialogSelectOption<GoalAction>[] {
  return [
    { title: "Show status", description: "/goal status", value: "status" },
    ...(isLimitedGoal(goal)
      ? [
          {
            title: "Extend limits…",
            description: "Explicitly raise or remove a limit",
            value: "extend" as const,
          },
        ]
      : [
          {
            title: isActiveGoal(goal) ? "Pause goal" : "Resume goal",
            description: isActiveGoal(goal) ? "/goal pause" : "/goal resume",
            value: "toggle" as const,
          },
        ]),
    { title: "Edit objective…", description: "/goal edit", value: "edit" },
    // Destructive: a single stray click must not destroy the goal, so this row
    // keeps DialogSelect's two-click confirm even though the menu opts in.
    { title: "Clear goal", description: "/goal clear", value: "clear", requireConfirmClick: true },
  ]
}

// Exported for tests: maps a menu selection onto a command dispatch.
export function handleGoalAction(input: {
  action: GoalAction
  dialog: DialogContext
  goal: Goal
  runCommand: (args: string) => void
}) {
  const { action, dialog, goal, runCommand } = input
  if (action === "status") runCommand("status")
  else if (action === "toggle") runCommand(isActiveGoal(goal) ? "pause" : "resume")
  else if (action === "clear") runCommand("clear")
  else if (action === "extend") void requestGoalExtension(dialog, runCommand)
  // Regression: this used to pass an `onConfirm` callback into DialogPrompt.show,
  // which silently discards it (see requestGoalEdit above), so the objective was
  // never updated. Await the returned value instead.
  else if (action === "edit") void requestGoalEdit(dialog, goalText(goal), runCommand)
}

type GoalNotice = { title: string; message: string; variant: "info" | "success" | "warning" | "error" }

// Exported for tests: dispatch + the "never fail silently" contract.
export function runGoalMenuCommand(input: {
  args: string
  sessionID: string | undefined
  commandName: string | undefined
  dispatch: (input: { sessionID: string; command: string; arguments: string }) => Promise<unknown>
  notify: (notice: GoalNotice) => void
  wasReported: () => boolean
  markReported: () => void
}) {
  const { args, sessionID, commandName, dispatch, notify, wasReported, markReported } = input
  if (!sessionID) {
    notify({
      title: "Goal unavailable",
      message: "Open a session before running goal commands.",
      variant: "error",
    })
    return
  }
  // Keep the existence guard (it protects against a disabled or renamed
  // plugin) but surface it: a silent return is indistinguishable from a dead
  // menu item. Dedupe so the 2s poll and a double click cannot stack toasts.
  if (!commandName) {
    if (wasReported()) return
    markReported()
    notify({
      title: "Goal unavailable",
      message: `The /${DEFAULT_GOAL_COMMAND} command is not available in this session, so the goal menu cannot be used.`,
      variant: "error",
    })
    return
  }
  // Rejections (e.g. "Command not found") must reach the user. The caller
  // passes throwOnError so a failed HTTP status rejects instead of resolving
  // with a silently-dropped `{ error }` field.
  void dispatch({ sessionID, command: commandName, arguments: args }).catch((error: unknown) => {
    notify({ title: "Goal command failed", message: errorMessage(error), variant: "error" })
  })
}

export function GoalBar(props: { sessionID?: string }) {
  const { theme } = useTheme()
  const event = useEvent()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const [goals, setGoals] = createSignal<Goal[]>([])

  const load = async () => {
    try {
      // The current path wins. The plugin-era path is a fallback, not dead weight: the server
      // migrates that file across on its first state read, so between a fresh install and that
      // read the bar would render nothing for a goal that is genuinely running.
      const file = Bun.file(statePath())
      const text = (await file.exists()) ? await file.text() : await Bun.file(legacyStateFile()).text()
      const parsed = JSON.parse(text) as unknown
      if (!parsed || typeof parsed !== "object") {
        setGoals([])
        return
      }
      const record = parsed as { goals?: unknown }
      let list: Goal[] = []
      if (Array.isArray(record.goals)) {
        list = record.goals as Goal[]
      } else if (record.goals && typeof record.goals === "object") {
        list = Object.values(record.goals as Record<string, Goal>)
      }
      const filtered = list.filter(
        (g) => g && isGoalStatus(g.status) && VISIBLE_STATUSES.has(g.status) && goalText(g),
      )
      if (props.sessionID) {
        // Strictly scoped: a session with no goal renders nothing.
        // Never fall back to other sessions' goals.
        setGoals(filtered.filter((g) => g.sessionID === props.sessionID))
      } else {
        // Home route (no sessionID) never shows global goals.
        setGoals([])
      }
    } catch {
      setGoals([])
    }
  }

  onMount(() => {
    void load()
    const timer = setInterval(load, GOAL_POLL_MS)
    const off1 = event.on("message.updated", () => void load())
    const off2 = event.on("session.status", () => void load())
    onCleanup(() => {
      clearInterval(timer)
      off1()
      off2()
    })
  })

  const activeGoal = createMemo(() => goals().find((g) => g.status === "active"))
  const pausedGoal = createMemo(() => goals().find((g) => g.status === "paused"))
  const limitedGoal = createMemo(() => goals().find((g) => g.status === "budgetLimited" || g.status === "usageLimited"))
  const visible = createMemo(() => activeGoal() ?? pausedGoal() ?? limitedGoal() ?? null)
  const paused = createMemo(() => !activeGoal() && Boolean(pausedGoal()))
  const limited = createMemo(() => !activeGoal() && !pausedGoal() && Boolean(limitedGoal()))

  const label = createMemo(() => (limited() ? "Goal limited" : paused() ? "Goal paused" : "Goal active"))
  const color = createMemo(() => (paused() || limited() ? theme.warning : theme.success))
  const elapsed = createMemo(() => {
    const startedAt = toEpochMillis(visible()?.createdAt)
    if (!Number.isFinite(startedAt)) return ""
    const seconds = Math.floor((Date.now() - startedAt) / 1000)
    // A clock skew, a bogus stored timestamp, or a unit mixup can produce a negative
    // or absurd duration; never render "2957 weeks". One year of continuous
    // auto-continue is not a real goal, so anything beyond it is treated as garbage.
    if (seconds <= 0 || seconds > 365 * 86400) return ""
    return formatDuration(seconds)
  })
  const objective = createMemo(() => {
    const goal = visible()
    if (!goal) return ""
    if (limited()) return goal.stopReason || "limit reached"
    // A goal paused for Plan mode is unblocked by switching to Build mode. Showing a bare
    // "Goal paused" hides the one action that would actually let the user continue, and the
    // "Resume goal" menu row would then fail.
    if (goal.status === "paused" && goal.stopReason === "plan mode") return "switch to Build mode to run this goal"
    // The title when there is one, the objective otherwise. The objective is the durable record and
    // is written to be as detailed as the work needs, which is the wrong shape for a one-row bar: it
    // truncated to a head-and-tail fragment that usually cut off the part naming the work. A title
    // the model wrote is a few words by construction, so it survives the row whole. Goals created
    // before titles existed, and titles that are blank, still fall through to the objective.
    return goalTitle(goal) || goalText(goal)
  })
  // The goal plugin always registers a command literally named `goal`.
  const goalCommandName = createMemo(() => {
    if (sync.data.command.some((x) => x.name === DEFAULT_GOAL_COMMAND)) return DEFAULT_GOAL_COMMAND
    return undefined
  })
  let reportedUnavailable = false
  createEffect(() => {
    if (goalCommandName()) reportedUnavailable = false
  })
  // The caret is its own element so it is a real hit target rather than an
  // implicit side effect of the whole row being clickable.
  const CARET = "▾"
  const CARET_WIDTH = 2 // " " + caret
  const prefix = createMemo(() => {
    const state = limited() ? "!" : paused() ? "Ⅱ" : "•"
    return `● ${state} ${label()} · `
  })
  const suffix = createMemo(() => (elapsed() ? ` · ${elapsed()}` : ""))

  function runGoalCommand(args: string) {
    runGoalMenuCommand({
      args,
      sessionID: props.sessionID,
      commandName: goalCommandName(),
      dispatch: (input) => sdk.client.session.command(input, { throwOnError: true }),
      notify: (options) => toast.show(options),
      wasReported: () => reportedUnavailable,
      markReported: () => {
        reportedUnavailable = true
      },
    })
  }

  function openMenu() {
    const goal = visible()
    if (!goal) return
    dialog.replace(() => (
      <DialogSelect<GoalAction>
        title="Goal"
        renderFilter={false}
        skipFilter
        // One click commits here. Every row is a labeled, cheap, reversible
        // goal action, and a first click that only moves the highlight reads as
        // a dead menu. "Clear goal" opts back into the two-click confirm because
        // it destroys the goal.
        singleClickConfirm
        options={goalMenuOptions(goal)}
        onSelect={(option) => {
          dialog.clear()
          handleGoalAction({
            action: option.value,
            dialog,
            goal,
            runCommand: runGoalCommand,
          })
        }}
      />
    ))
  }

  return (
    <Show when={visible()}>
      <box
        width="100%"
        flexShrink={0}
        flexDirection="row"
        alignItems="center"
        paddingLeft={2}
        paddingTop={1}
        backgroundColor={theme.backgroundElement}
        onMouseUp={() => openMenu()}
      >
        {/* The status marker carries the only saturated color; the objective reads as body
            text and the clock and caret recede, so one accent per row does not shout across
            the full panel width. */}
        <text flexShrink={0} fg={color()}>
          {prefix()}
        </text>
        {/* Width is left to flexbox on purpose. This bar lives inside the session layout, so
            its container is narrower than the terminal; sizing against terminal dimensions
            overestimated the row by ~45 columns, overflowed, and pushed the clock and caret
            off the panel. The objective grows into whatever space the fixed chrome leaves and
            is the only segment that yields when cramped, so the elapsed time and caret are
            never the thing that gets dropped. */}
        <text
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          fg={theme.text}
          wrapMode="none"
          truncate
        >
          {objective()}
        </text>
        <text flexShrink={0} fg={theme.textMuted}>
          {suffix()}
        </text>
        {/* Explicit caret affordance. It carries its own handler so the caret
            reads as the control it looks like; the row handler still covers
            clicks anywhere else on the bar. stopPropagation keeps a caret
            click from opening the menu twice. */}
        <text width={CARET_WIDTH} flexShrink={0} fg={theme.textMuted} onMouseUp={(e: { stopPropagation(): void }) => {
          e.stopPropagation()
          openMenu()
        }}>
          {" " + CARET}
        </text>
      </box>
    </Show>
  )
}
