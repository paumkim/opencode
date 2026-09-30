/**
 * Visible-window terminals.
 *
 * `libghostty-vt` is a VT *state* engine: it parses a host's byte stream and
 * hands back a renderable screen for a host to draw. It has no window, no GPU
 * renderer, and no way to put anything on a user's screen. So a session backed
 * by it is structurally headless, no matter how it is configured.
 *
 * This module is the other path: it launches the real Ghostty *application* so
 * a window appears on the user's display. The window renders a tmux session, and
 * the agent drives that same session over tmux, so `write` and `screen` keep
 * working and the agent sees exactly what the user sees.
 *
 * This is the only way to be live AND readable at the same time.
 */

import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export type VisibleOpts = {
  /** tmux session name. Must already be unique per owner. */
  session: string
  cwd: string
  cols: number
  rows: number
  /** Host environment; must carry the display variables. */
  env: Record<string, string>
  /** Window title shown in the taskbar. */
  title: string
  /** Shell used inside the window, resolved by tmux. */
  shell: string
}

export type VisibleInfo = {
  session: string
  pid: number | undefined
  cols: number | undefined
  rows: number | undefined
  attached: boolean
  /** The shell inside the window has exited; the final screen is retained. */
  exited: boolean
  created: string | undefined
}

/** Raised when the user asked for a live window we cannot deliver. Never
 * silently degrade to headless: the whole point is that the user can see it. */
export class VisibleUnavailableError extends Error {
  readonly hint: string
  constructor(message: string, hint: string) {
    super(message)
    this.name = "VisibleUnavailableError"
    this.hint = hint
  }
}

/**
 * Visible terminals live on their own tmux server, never the shared one.
 *
 * The user's own `tmux` sessions, and other tools that bridge a window to tmux (for example
 * `~/.local/bin/oc-live`, which runs on the default socket), share one server. Agent-owned
 * sessions have to be invisible to all of that: a collision means two different things fight
 * over one session name, and a stray `dispose` on the shared server takes the user's windows
 * down with it.
 *
 * `||` rather than `??` is deliberate. An exported-but-empty `OPENCODE_TMUX_SOCKET` must fall
 * back to the dedicated name; passing a bare `-L ""` instead makes every tmux call fail with
 * "error connecting to /tmp/tmux-1000/ (Is a directory)", which reads like tmux is broken.
 */
export const DEFAULT_TMUX_SOCKET = "opencode-agent"

let resolved: string | undefined
export function tmuxSocket(): string {
  if (resolved !== undefined) return resolved
  const name = process.env.OPENCODE_TMUX_SOCKET || DEFAULT_TMUX_SOCKET
  if (name === "default") {
    throw new VisibleUnavailableError(
      "OPENCODE_TMUX_SOCKET is set to 'default', which is the shared tmux server.",
      "Visible terminals must not share it with the user's own sessions. Unset OPENCODE_TMUX_SOCKET to use '" +
        DEFAULT_TMUX_SOCKET +
        "'.",
    )
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new VisibleUnavailableError(
      `OPENCODE_TMUX_SOCKET ('${name}') is not a usable tmux socket name.`,
      "Use letters, digits, '_', '-' and '.' only, or unset it to use '" + DEFAULT_TMUX_SOCKET + "'.",
    )
  }
  resolved = name
  return resolved
}

/** tmux forbids `.` and `:` in session names; the tool already restricts the
 * short name to `[A-Za-z0-9_-]`, so only the owner needs sanitising. */
function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-")
}

/** tmux is one global server, so two agents both asking for "main" would fight
 * over the same session. Scope every session to its owner, and give the owner a
 * stable prefix so `list` can find them again. */
export function sessionPrefix(owner: string): string {
  const digest = createHash("sha256").update(owner).digest("hex").slice(0, 10)
  return `oc-${sanitize(owner).slice(0, 24)}-${digest}-`
}

export function sessionName(owner: string, name: string): string {
  // The tool already restricts the short name, but sanitising here means a
  // future caller cannot hand tmux a name it will reject.
  return `${sessionPrefix(owner)}${sanitize(name)}`
}

function displayError(): string | undefined {
  if (process.platform === "darwin") return undefined
  if (!process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) {
    return "no WAYLAND_DISPLAY and no DISPLAY in this process's environment"
  }
  return undefined
}

function tmuxCommand(args: string[]) {
  const result = spawnSync("tmux", ["-L", tmuxSocket(), ...args], { encoding: "utf8" })
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new VisibleUnavailableError(
        "tmux is not installed, so a live window cannot be shared with the agent.",
        "Install tmux, or ask for a headless terminal instead.",
      )
    }
    throw new Error(`tmux failed: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || `tmux exited ${result.status}`).trim())
  }
  return result.stdout ?? ""
}

const SESSION_FORMAT = "#{session_name}\t#{session_attached}\t#{session_created}"
const WINDOW_FORMAT = "#{window_width}\t#{window_height}\t#{pane_dead}"

function parseRows(stdout: string, prefix?: string): VisibleInfo[] {
  const out: VisibleInfo[] = []
  for (const line of stdout.trim().split("\n")) {
    if (!line) continue
    const [name, attached, created] = line.split("\t")
    if (!name) continue
    if (prefix !== undefined && !name.startsWith(prefix)) continue
    const createdSeconds = toInt(created)
    out.push({
      session: name,
      pid: undefined,
      cols: undefined,
      rows: undefined,
      attached: Number(attached) > 0,
      exited: false,
      created: createdSeconds === undefined ? undefined : new Date(createdSeconds * 1000).toISOString(),
    })
  }
  return out
}

/** Best-effort tmux session info. Returns undefined when the session is gone,
 * which is normal once the user closes the window. */
export function info(session: string): VisibleInfo | undefined {
  let rows: VisibleInfo[]
  try {
    // `list-sessions` has no -t flag; filter client-side.
    rows = parseRows(tmuxCommand(["list-sessions", "-F", SESSION_FORMAT]), session)
  } catch {
    return undefined
  }
  const found = rows.find((row) => row.session === session)
  if (!found) return undefined
  found.pid = panePid(session)
  try {
    const [width, height, dead] = tmuxCommand(["list-windows", "-t", session, "-F", WINDOW_FORMAT])
      .trim()
      .split("\n")[0]!
      .split("\t")
    found.cols = toInt(width)
    found.rows = toInt(height)
    found.exited = dead === "1"
  } catch {
    // Geometry is cosmetic; keep the session entry.
  }
  return found
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function exists(session: string): boolean {
  return info(session) !== undefined
}

function resolveOnPath(binary: string, env: Record<string, string>): string | undefined {
  const override = env[`OPENCODE_${binary.toUpperCase()}_BIN`]
  if (override) return fs.existsSync(override) ? override : undefined
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, binary)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // keep scanning
    }
  }
  return undefined
}

/**
 * Open a real window for the user.
 *
 * The session is created detached *first* so the window never races its own
 * target: `ghostty -e tmux attach` against a missing session would open a
 * window that immediately prints "no such session" and closes.
 */
export function create(opts: VisibleOpts): void {
  const display = displayError()
  if (display) {
    throw new VisibleUnavailableError(
      `A live window was requested but this process has no display (${display}).`,
      "Tell the user a live window is impossible here, and offer a headless terminal instead. Do not silently continue headless.",
    )
  }
  const ghostty = resolveOnPath("ghostty", opts.env)
  if (!ghostty) {
    throw new VisibleUnavailableError(
      "The Ghostty application was not found on PATH, so no live window can be opened.",
      "Install Ghostty, or ask for a headless terminal instead. Do not silently continue headless.",
    )
  }
  // Errors here (session exists, bad size) must surface before the window opens.
  tmuxCommand([
    "new-session",
    "-d",
    "-s",
    opts.session,
    "-x",
    String(opts.cols),
    "-y",
    String(opts.rows),
    "-c",
    opts.cwd,
  ])
  // A tmux window with no live pane cannot exist, so without this the shell
  // exiting would take the session, the screen, and the user's window with it.
  // With it, `kill` leaves the final screen readable, matching headless.
  tmuxCommand(["set-option", "-t", opts.session, "remain-on-exit", "on"])

  // A Wayland compositor presents a window in the session that creates it.
  // `detached: true` (and `setsid` with it) starts a brand new session with no
  // activation token, so the window process runs and never appears — verified on
  // KDE Plasma in script/crew.sh, where `setsid nohup ghostty` was invisible and
  // plain `nohup ghostty` was not. So the window must stay in the caller's
  // session. `unref` is enough to keep this from holding the agent process open,
  // and stdio is redirected so the launching tool call never blocks on the window.
  const child = spawn(
    ghostty,
    [`--title=${opts.title}`, "-e", "tmux", "-L", tmuxSocket(), "attach-session", "-t", opts.session],
    {
      env: opts.env,
      stdio: "ignore",
    },
  )
  child.unref()
  child.on("error", () => {
    // The window failed to open. The tmux session still exists and stays
    // usable; `info` reports the truth and the tool tells the user.
  })
}

/** Escape sequences that must arrive as a real key press rather than as bytes. */
const SEQUENCE_KEYS = new Map<string, string>([
  ["\x1b[1;5A", "C-Up"], ["\x1b[1;5B", "C-Down"], ["\x1b[1;5C", "C-Right"], ["\x1b[1;5D", "C-Left"],
  ["\x1b[15~", "F5"], ["\x1b[17~", "F6"], ["\x1b[18~", "F7"], ["\x1b[19~", "F8"],
  ["\x1b[20~", "F9"], ["\x1b[21~", "F10"], ["\x1b[23~", "F11"], ["\x1b[24~", "F12"],
  ["\x1b[Z", "BTab"],
  ["\x1b[A", "Up"], ["\x1b[B", "Down"], ["\x1b[C", "Right"], ["\x1b[D", "Left"],
  ["\x1b[H", "Home"], ["\x1b[F", "End"], ["\x1bOH", "Home"], ["\x1bOF", "End"],
  ["\x1b[1~", "Home"], ["\x1b[2~", "IC"], ["\x1b[3~", "DC"], ["\x1b[4~", "End"],
  ["\x1b[5~", "PageUp"], ["\x1b[6~", "PageDown"],
  ["\x1bOA", "Up"], ["\x1bOB", "Down"], ["\x1bOC", "Right"], ["\x1bOD", "Left"],
  ["\x1bOP", "F1"], ["\x1bOQ", "F2"], ["\x1bOR", "F3"], ["\x1bOS", "F4"],
])

const CONTROL: Record<string, string> = {}
// Ctrl+A is 0x01 and 'a' is 0x61, so the letter is 97 + i, not 96 + i.
for (let i = 0; i < 26; i++) CONTROL[String.fromCharCode(i + 1)] = `C-${String.fromCharCode(97 + i)}`
CONTROL["\x1c"] = "C-\\"
CONTROL["\x1d"] = "C-]"
CONTROL["\x1e"] = "C-^"
CONTROL["\x1f"] = "C-_"
CONTROL["\r"] = "Enter"
CONTROL["\n"] = "Enter"
CONTROL["\t"] = "Tab"
CONTROL["\x7f"] = "BSpace"

/**
 * Split agent input into tmux arguments.
 *
 * `write` takes raw keystrokes, not text to paste, so control characters must
 * become real key presses. Literal runs go through `send-keys -l` (the `--`
 * stops a run that begins with `-` from being read as an option).
 *
 * A recognised escape sequence becomes a key name. A sequence we do not
 * recognise is forwarded as its original bytes instead of being shredded into
 * `Escape` plus typed-out bracket text, so a raw CSI still reaches the process
 * as a raw CSI.
 */
export function toTmuxArgs(data: string): string[] {
  const args: string[] = []
  let literal = ""
  const flush = () => {
    if (!literal) return
    args.push("-l", "--", literal)
    literal = ""
  }
  const isParam = (char: string) => char >= "\x30" && char <= "\x3f"
  const isIntermediate = (char: string) => char >= "\x20" && char <= "\x2f"
  const isFinal = (char: string) => char >= "\x40" && char <= "\x7e"

  let i = 0
  while (i < data.length) {
    const char = data[i]!
    if (char === "\x1b") {
      const next = data[i + 1]
      // CSI: ESC [ params intermediates final. SS3: ESC O final.
      let end = -1
      if (next === "[") {
        end = i + 2
        while (end < data.length && isParam(data[end]!)) end++
        while (end < data.length && isIntermediate(data[end]!)) end++
        if (end < data.length && isFinal(data[end]!)) end++
        else end = -1
      } else if (next === "O") {
        end = i + 3
        if (end <= data.length && isFinal(data[i + 2] ?? "")) {
          // ok
        } else {
          end = -1
        }
      }
      if (end > 0) {
        const sequence = data.slice(i, end)
        const key = SEQUENCE_KEYS.get(sequence)
        flush()
        if (key) args.push(key)
        else args.push("-l", "--", sequence)
        i = end
        continue
      }
      // A lone ESC, or one in front of ordinary text: the Escape key.
      flush()
      args.push("Escape")
      i += 1
      continue
    }
    const control = CONTROL[char]
    if (control) {
      flush()
      args.push(control)
      i += 1
      continue
    }
    literal += char
    i += 1
  }
  flush()
  return args
}

export function write(session: string, data: string): void {
  const args = toTmuxArgs(data)
  if (!args.length) return
  tmuxCommand(["send-keys", "-t", session, ...args])
}

export function screen(session: string, format: "plain" | "html" = "plain"): string {
  // `-e` keeps SGR attributes so colour survives as escapes; the ghostty
  // `html` renderer has no counterpart here, so it degrades to plain text.
  const stdout = tmuxCommand(["capture-pane", "-p", ...(format === "html" ? ["-e"] : []), "-t", session])
  return stdout.replace(/\s+$/, "")
}

export function resize(session: string, cols: number, rows: number): void {
  tmuxCommand(["resize-window", "-t", session, "-x", String(cols), "-y", String(rows)])
}

const SIGNALS: Record<string, NodeJS.Signals> = {
  TERM: "SIGTERM",
  KILL: "SIGKILL",
  INT: "SIGINT",
  HUP: "SIGHUP",
}

/**
 * Signal the shell inside the window, leaving the session and window alive.
 *
 * This mirrors the headless contract — signal the owned shell, keep the final
 * screen readable until dispose. Killing the tmux session instead would take
 * the user's window down with it and lose the screen.
 */
export function kill(session: string, signal = "SIGTERM"): void {
  const pid = panePid(session)
  if (pid === undefined) return
  try {
    process.kill(pid, SIGNALS[signal.replace(/^SIG/, "").toUpperCase()] ?? "SIGTERM")
  } catch (error) {
    // The shell already exited, or we may not signal it. Disposing is the
    // supported way to guarantee the window goes away.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

function panePid(session: string): number | undefined {
  let stdout: string
  try {
    stdout = tmuxCommand(["list-panes", "-t", session, "-F", "#{pane_pid}"])
  } catch {
    return undefined
  }
  return toInt(stdout.trim().split("\n")[0])
}

export function dispose(session: string): void {
  if (!exists(session)) return
  tmuxCommand(["kill-session", "-t", session])
}

export function list(prefix: string): VisibleInfo[] {
  let rows: VisibleInfo[]
  try {
    rows = parseRows(tmuxCommand(["list-sessions", "-F", SESSION_FORMAT]), prefix)
  } catch {
    return []
  }
  for (const row of rows) row.pid = panePid(row.session)
  return rows
}
