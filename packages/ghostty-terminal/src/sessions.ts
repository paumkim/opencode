import { GhosttyTerminal, withTuiEnv, type ExitEvent, type TerminalOpts, type WriteOpts, type ScreenOpts, type ScreenState, type CursorState } from "./index.js"

export type ScreenFormat = "plain" | "html"
export type { WriteOpts, ScreenOpts, ScreenState, CursorState }
export type SessionInfo = {
  name: string
  pid: number
  cols: number
  rows: number
  exited: boolean
  exitCode?: number
  signal?: number | string
}

type Entry = { terminal: GhosttyTerminal; exit?: ExitEvent }
const live = new Set<TerminalSessions>()
function onExit() {
  for (const sessions of [...live]) {
    try { sessions.close() } catch (error) { console.error("Terminal cleanup failed", error) }
  }
}

/** All registry operations are synchronous and contain no yield/await, so they are
 * atomic within one JS isolate, including duplicate creation and close vs write.
 * Never expose native handles to callers. Exited screens are retained until disposal.
 */
export class TerminalSessions {
  private entries = new Map<string, Entry>()
  private closed = false

  create(name: string, opts: TerminalOpts, file: string, args: string[] = []): SessionInfo {
    if (this.closed) throw new Error("Terminal registry is closed")
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw new RangeError("Session name must be 1-64 letters, digits, '_' or '-'")
    }
    if (this.entries.has(name)) throw new Error(`Terminal session '${name}' already exists`)
    if (this.entries.size >= 16) throw new Error("Dispose a terminal before creating more (limit: 16)")
    // Bound viewport allocation independently of the native engine's u16 ABI limit.
    if (!Number.isInteger(opts.cols) || !Number.isInteger(opts.rows) ||
        opts.cols < 1 || opts.rows < 1 || opts.cols > 500 || opts.rows > 200) {
      throw new RangeError("Terminal dimensions must be integers: cols 1-500, rows 1-200")
    }
    const terminal = new GhosttyTerminal({ ...opts, env: withTuiEnv(opts.env) })
    const entry: Entry = { terminal }
    terminal.onExit((event) => { entry.exit = event })
    try {
      terminal.spawn(file, args)
    } catch (cause) {
      terminal.dispose()
      throw cause
    }
    this.entries.set(name, entry)
    if (!live.size) process.on("exit", onExit)
    live.add(this)
    return this.info(name)
  }

  private require(name: string): Entry {
    if (this.closed) throw new Error("Terminal registry is closed")
    const entry = this.entries.get(name)
    if (!entry) throw new Error(`Unknown terminal session '${name}'`)
    return entry
  }

  info(name: string): SessionInfo {
    const entry = this.require(name)
    return {
      name,
      pid: entry.terminal.pid,
      cols: entry.terminal.cols,
      rows: entry.terminal.rows,
      exited: entry.exit !== undefined,
      ...(entry.exit ? { exitCode: entry.exit.code, signal: entry.exit.signal } : {}),
    }
  }

  write(name: string, data: string, opts: WriteOpts = {}): void {
    this.require(name).terminal.write(data, opts)
  }

  screen(name: string, format: ScreenFormat = "plain", opts: ScreenOpts = {}): string {
    return this.require(name).terminal.readScreen(format, opts)
  }

  /** Structured viewport snapshot with cursor/alt-screen state. */
  screenState(name: string, opts: ScreenOpts = {}): ScreenState {
    return this.require(name).terminal.readScreenState(opts)
  }

  cursor(name: string): CursorState {
    return this.require(name).terminal.readCursor()
  }

  resize(name: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 500 || rows > 200) {
      throw new RangeError("Terminal dimensions must be integers: cols 1-500, rows 1-200")
    }
    this.require(name).terminal.resize(cols, rows)
  }

  kill(name: string, signal = "SIGTERM"): void {
    this.require(name).terminal.kill(signal)
  }

  dispose(name: string): void {
    const entry = this.entries.get(name)
    if (!entry) return // Idempotent, including concurrent disposal requests.
    this.entries.delete(name)
    try { entry.terminal.dispose() } finally {
      if (!this.entries.size) live.delete(this)
      if (!live.size) process.off("exit", onExit)
    }
  }

  list(): SessionInfo[] {
    return [...this.entries.keys()].map((name) => this.info(name))
  }

  disposeAll(): void {
    const errors: unknown[] = []
    for (const name of this.entries.keys()) {
      try { this.dispose(name) } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, "Terminal disposal failed")
  }

  close(): void {
    this.closed = true // A delayed caller cannot resurrect a disposed instance.
    this.disposeAll()
  }
}
