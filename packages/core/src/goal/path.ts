import { join } from "node:path"
import { homedir } from "node:os"

/**
 * Where goal state lives on disk.
 *
 * The server (`packages/opencode/src/goal/impl.ts`) writes this file and the terminal
 * UI (`packages/tui/src/component/prompt/goal-bar.tsx`) reads it, but the two live in
 * different packages and the UI has no server dependency. So the path lived in both, and
 * when it moved off the plugin-era directory only one copy moved: the UI kept polling
 * the abandoned file and rendered nothing, which looked exactly like goal mode being
 * off. One definition, two consumers, no way to drift again.
 *
 * Resolution is deliberately lazy - it re-reads the environment on every call rather than
 * freezing at module load - because tests point `XDG_DATA_HOME` at a temp directory to
 * observe migration.
 */
function dataHomeDir() {
  return (
    process.env.XDG_DATA_HOME ||
    (process.platform === "win32" && process.env.APPDATA ? process.env.APPDATA : join(homedir(), ".local", "share"))
  )
}

export function statePath() {
  return process.env.OPENCODE_GOAL_STATE_PATH || join(dataHomeDir(), "opencode-goal", "goals.json")
}

/**
 * Goal mode shipped as a plugin once, and its state directory kept the name. Now that the
 * feature is core the directory no longer says anything true, so it moved - but goals
 * (including any in-flight unattended one) live in that file. Migrate rather than abandon it.
 *
 * Only meaningful when the path is not overridden: an explicit `OPENCODE_GOAL_STATE_PATH`
 * means the caller chose the location, so the legacy default is not a candidate.
 */
export function legacyStateFile() {
  const dataHome =
    process.env.XDG_DATA_HOME ||
    (process.platform === "win32" && process.env.APPDATA ? process.env.APPDATA : join(homedir(), ".local", "share"))
  return join(dataHome, "opencode-goal-plugin", "goals.json")
}
