import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { useTheme } from "../../context/theme"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { DialogPrompt } from "../../ui/dialog-prompt"
import os from "node:os"
import path from "node:path"

const GOAL_POLL_MS = 2_000

type GoalStatus = "active" | "paused" | "open" | "blocked" | "budgetLimited" | "usageLimited" | "complete" | "unmet" | "done"

type Goal = {
  id?: string
  sessionID?: string
  objective?: string
  text?: string
  status: GoalStatus | string
  createdAt: number | string
  updatedAt?: number | string
}

function defaultStateFile() {
  const dataHome =
    process.env.XDG_DATA_HOME ||
    (process.platform === "win32" && process.env.APPDATA ? process.env.APPDATA : path.join(os.homedir(), ".local", "share"))
  return path.join(dataHome, "opencode-goal-plugin", "goals.json")
}

function statePath() {
  return process.env.OPENCODE_GOAL_STATE_PATH || defaultStateFile()
}

function goalText(g: Goal): string {
  if (typeof g.objective === "string" && g.objective.trim()) return g.objective
  if (typeof g.text === "string" && g.text.trim()) return g.text
  return ""
}

// Only in-progress goals render the bar. Terminal states
// (complete/unmet/done) stay hidden so the prompt keeps zero
// extra rows when there is no active goal (Kilo-like behavior).
const VISIBLE_STATUSES = new Set(["active", "paused", "open", "blocked", "budgetLimited", "usageLimited"])

type GoalAction = "status" | "toggle" | "edit" | "clear"

export function GoalBar(props: { sessionID?: string }) {
  const { theme } = useTheme()
  const event = useEvent()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [goals, setGoals] = createSignal<Goal[]>([])

  const load = async () => {
    try {
      const text = await Bun.file(statePath()).text()
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
        (g) => g && typeof g.status === "string" && VISIBLE_STATUSES.has(g.status) && goalText(g),
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

  const activeGoal = createMemo(() => goals().find((g) => g.status === "active" || g.status === "open"))
  const pausedGoal = createMemo(() => goals().find((g) => g.status === "paused" || g.status === "blocked"))
  const limitedGoal = createMemo(() => goals().find((g) => g.status === "budgetLimited" || g.status === "usageLimited"))
  const visible = createMemo(() => activeGoal() ?? pausedGoal() ?? limitedGoal() ?? null)
  const paused = createMemo(() => !activeGoal() && Boolean(pausedGoal()))
  const limited = createMemo(() => !activeGoal() && !pausedGoal() && Boolean(limitedGoal()))

  const label = createMemo(() => (limited() ? "Goal limited" : paused() ? "Goal paused" : "Goal active"))
  const color = createMemo(() => (paused() || limited() ? theme.warning : theme.success))

  function runGoalCommand(args: string) {
    const sessionID = props.sessionID
    if (!sessionID) return
    if (!sync.data.command.some((x) => x.name === "goal")) return
    void sdk.client.session.command({ sessionID, command: "goal", arguments: args })
  }

  function openMenu() {
    const goal = visible()
    if (!goal) return
    const isActive = goal.status === "active" || goal.status === "open"
    dialog.replace(() => (
      <DialogSelect<GoalAction>
        title="Goal"
        renderFilter={false}
        skipFilter
        options={[
          { title: "Show status", description: "/goal status", value: "status" },
          {
            title: isActive ? "Pause goal" : "Resume goal",
            description: isActive ? "/goal pause" : "/goal resume",
            value: "toggle",
          },
          { title: "Edit objective…", description: "/goal edit", value: "edit" },
          { title: "Clear goal", description: "/goal clear", value: "clear" },
        ]}
        onSelect={(option) => {
          dialog.clear()
          const action = option.value
          if (action === "status") runGoalCommand("status")
          else if (action === "toggle") runGoalCommand(isActive ? "pause" : "resume")
          else if (action === "clear") runGoalCommand("clear")
          else if (action === "edit") {
            void DialogPrompt.show(dialog, "Edit goal", {
              value: goalText(goal),
              placeholder: "Goal objective",
              onConfirm: (value) => {
                dialog.clear()
                if (value.trim()) runGoalCommand(`edit ${value.trim()}`)
              },
            })
          }
        }}
      />
    ))
  }

  return (
    <Show when={visible()}>
      <box width="100%" height={1} flexShrink={0} paddingLeft={2} onMouseUp={() => openMenu()}>
        <text wrapMode="none" truncate style={{ fg: color() }}>
          {label()} {" ▾"}
        </text>
      </box>
    </Show>
  )
}
