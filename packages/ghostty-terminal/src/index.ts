import { spawn, type IDisposable, type IPty } from "bun-pty"
import { constants } from "node:os"
import type { Pointer } from "bun:ffi"
import {
  createTerminal, freeTerminal, writeTerminal, resizeTerminal,
  formatTerminalText, formatTerminalHtml, setWritePty, validateDimensions,
} from "./ffi/bindings.js"
import { PtyError } from "./error/errors.js"
import type { TerminalOpts, PtyLike, ExitEvent, WriteOpts, ScreenOpts, ScreenState, CursorState } from "./ffi/types.js"
import { TUI_ENV_DEFAULTS, TUI_ENV_PASSTHROUGH } from "./ffi/types.js"

export type { TerminalOpts, PtyLike, ExitEvent, WriteOpts, ScreenOpts, ScreenState, CursorState } from "./ffi/types.js"

/** Fill TUI-critical env (TERM/COLORTERM/LANG/...) from host or safe defaults.
 * The OpenTUI Solid renderer needs TERM=xterm-256color + COLORTERM=truecolor
 * for truecolor, and a UTF-8 LANG for wide-char widths. Explicit caller values win. */
export function withTuiEnv(env: Record<string, string> | undefined): Record<string, string> {
  const merged: Record<string, string> = { ...env }
  for (const key of TUI_ENV_PASSTHROUGH) {
    const host = process.env[key]
    if (merged[key] === undefined && host !== undefined) merged[key] = host
  }
  for (const [key, fallback] of Object.entries(TUI_ENV_DEFAULTS)) {
    if (merged[key] === undefined) merged[key] = fallback
  }
  return merged
}

/** Agent-side composition, not a replacement for core's raw PTY backend.
 * Explicitly dispose each instance, including after exit (the final screen is retained).
 */
export class GhosttyTerminal implements PtyLike {
  private handle: Pointer | null
  private pty: IPty | null = null
  private subscriptions: IDisposable[] = []
  private outputListeners = new Set<(data: string) => void>()
  private exitListeners = new Set<(event: ExitEvent) => void>()
  private disposed = false
  private exited = false
  private responses: Uint8Array[] = []
  private responseScheduled = false
  private decoder = new TextDecoder()
  private dimensions: { cols: number; rows: number }
  private readonly opts: TerminalOpts
  // Best-effort cursor/alt-screen tracking from the VT output stream.
  // Native ghostty_render_state_* cursor binding is deliberately avoided: the
  // sized-struct + iterator ABI is too risky for Bun FFI, so we parse the
  // cursor-affecting escapes (CUP/CUH/CUB/CUF/CUU/CUD/CR/LF/BS/ED/DECSET 1049/25,
  // DECSC/DECRC) that the OpenTUI renderer actually emits.
  private cursor: CursorState = { x: 0, y: 0, visible: true, altScreen: false }
  private savedCursor: { x: number; y: number } | null = null

  constructor(opts: TerminalOpts) {
    this.opts = { ...opts, env: opts.env ? { ...opts.env } : undefined }
    this.dimensions = { cols: opts.cols, rows: opts.rows }
    // Missing engine/headers/ABI must fail construction, never pretend a PTY is Ghostty.
    this.handle = createTerminal(opts.cols, opts.rows)
    try {
      setWritePty(this.handle, (bytes) => this.queueResponse(bytes))
    } catch (cause) {
      freeTerminal(this.handle)
      this.handle = null
      throw cause
    }
  }

  get pid(): number {
    return this.pty?.pid ?? 0
  }

  get cols(): number { return this.dimensions.cols }
  get rows(): number { return this.dimensions.rows }

  onData(fn: (data: string) => void): IDisposable {
    this.requireHandle()
    this.outputListeners.add(fn)
    return { dispose: () => { this.outputListeners.delete(fn) } }
  }

  onExit(fn: (event: ExitEvent) => void): IDisposable {
    this.requireHandle()
    this.exitListeners.add(fn)
    return { dispose: () => { this.exitListeners.delete(fn) } }
  }

  /** Spawn once, synchronously. Listeners may be installed before or immediately after. */
  spawn(file: string, args: string[] = []): void {
    this.requireHandle()
    if (this.pty) throw new PtyError("Terminal has already spawned")
    try {
      this.pty = spawn(file, args, {
        ...this.opts,
        ...this.dimensions,
        name: this.opts.name ?? "xterm-256color",
        cwd: this.opts.cwd ?? process.cwd(),
        env: this.opts.env ? withTuiEnv(this.opts.env) : withTuiEnv(Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === "string"))),
      })
      this.subscriptions.push(this.pty.onData((data) => {
        if (this.disposed) return
        // bun-pty emits streaming-decoded UTF-8 strings; re-encode for Ghostty and the agent view.
        const bytes = Buffer.from(data, "utf8")
        writeTerminal(this.requireHandle(), bytes)
        this.trackCursor(data)
        const text = this.decoder.decode(bytes, { stream: true })
        if (text) this.emitData(text)
      }))
      this.subscriptions.push(this.pty.onExit((event) => {
        if (this.disposed || this.exited) return
        this.exited = true
        this.responses.length = 0
        const final = this.decoder.decode()
        if (final) this.emitData(final)
        const exit: ExitEvent = {
          exitCode: event.exitCode,
          code: event.exitCode,
          ...(event.signal ? { signal: event.signal } : {}),
        }
        this.detach()
        // bun-pty releases its fds/handle only on kill(); after exit this just closes.
        try { this.pty?.kill() } catch { /* already closed by a racing dispose */ }
        for (const listener of this.exitListeners) listener(exit)
        this.exitListeners.clear()
        this.outputListeners.clear()
      }))
    } catch (cause) {
      this.dispose()
      throw new PtyError(`Failed to spawn ${file}`, cause)
    }
  }

  /** Input goes to the real process, not directly into the screen parser.
   * Opt-in framing only: bracketedPaste wraps data in CSI 200~ / CSI 201~ so
   * TUIs with mode 2004 enabled treat it as a paste. Kitty keyboard (CSI u)
   * and SGR mouse (1006) sequences are passed through raw by default. */
  write(data: string, opts: WriteOpts = {}): void {
    const payload = opts.bracketedPaste ? `\x1b[200~${data}\x1b[201~` : data
    this.requirePty().write(payload)
  }

  /** Current Ghostty visible viewport, not a raw-output transcript.
   * Backward compat: readScreen() with no opts returns the same trimmed
   * text/html as before. preserveTrailingSpace pads plain lines to cols. */
  readScreen(format: "plain" | "html" = "plain", opts: ScreenOpts = {}): string {
    return this._readScreen(format, opts)
  }

  /** Async: waits a fixed delay then reads the screen.
   * Use after write() to give the shell time to process input and produce output.
   * A stability-based poll is unreliable because the echoed command line itself
   * can appear "stable" before the command's actual output arrives. */
  async readScreenWait(format: "plain" | "html" = "plain", opts: { wait?: number; preserveTrailingSpace?: boolean } = {}): Promise<string> {
    this.requireHandle()
    const delay = opts.wait ?? 1000
    await Bun.sleep(delay)
    return this._readScreen(format, { preserveTrailingSpace: opts.preserveTrailingSpace })
  }

  private _readScreen(format: "plain" | "html", opts: ScreenOpts): string {
    const handle = this.requireHandle()
    let out: string
    if (format === "plain") out = formatTerminalText(handle, this.dimensions.cols, this.dimensions.rows)
    else if (format === "html") out = formatTerminalHtml(handle, this.dimensions.cols, this.dimensions.rows)
    else throw new RangeError("Screen format must be plain or html")
    if (format === "plain" && opts.preserveTrailingSpace) {
      out = out.split("\n").map((line) => line.padEnd(this.dimensions.cols, " ")).join("\n")
    }
    return out
  }

  /** Structured snapshot: text + html + best-effort cursor/alt-screen state. */
  readScreenState(opts: ScreenOpts = {}): ScreenState {
    return {
      text: this.readScreen("plain", opts),
      html: this.readScreen("html", opts),
      cursor: { ...this.cursor },
      cols: this.dimensions.cols,
      rows: this.dimensions.rows,
    }
  }

  /** Best-effort cursor position/visibility/alt-screen from parsed output. */
  readCursor(): CursorState {
    this.requireHandle()
    return { ...this.cursor }
  }

  resize(cols: number, rows: number): void {
    const pty = this.requirePty()
    validateDimensions(cols, rows)
    const previous = this.dimensions
    // Ghostty parser first, then the kernel PTY (which delivers SIGWINCH so
    // the child re-renders at the new size). On PTY failure roll the parser
    // back so both stay in sync; the kernel size cannot be rolled back, so
    // parser-first is the only order with a safe rollback path.
    resizeTerminal(this.requireHandle(), cols, rows)
    try {
      pty.resize(cols, rows)
    } catch (cause) {
      resizeTerminal(this.requireHandle(), previous.cols, previous.rows)
      throw cause
    }
    this.dimensions = { cols, rows }
  }

  /**
   * Signal the owned child, leaving the PTY open for output and natural onExit.
   * SIGINT retains terminal-input semantics: ETX requires ISIG and the default VINTR.
   * Other signals target only the spawned PID, not its descendants/foreground group.
   */
  kill(signal = "SIGTERM"): void {
    const pty = this.requirePty()
    if (signal === "SIGINT") {
      pty.write("\x03")
      return
    }
    if (process.platform === "win32" || !Object.hasOwn(constants.signals, signal)) {
      throw new PtyError(`Signal ${signal} is not supported on ${process.platform}`)
    }
    // Never let an invalid transport PID become kill(0), kill(-1), or a group signal.
    // requirePty also prevents using the retained PID after exit/disposal.
    if (!Number.isSafeInteger(pty.pid) || pty.pid <= 0 || pty.pid === process.pid) {
      throw new PtyError("Cannot signal an invalid owned child PID")
    }
    // bun-pty.kill ignores the signal, closes immediately, and synthesizes code 0.
    // Reserve it for transport cleanup; errors here (including ESRCH) stay visible.
    process.kill(pty.pid, signal as NodeJS.Signals)
  }

  /** Stops delivery and queued replies; kills a live child and frees only this engine. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.responses.length = 0
    this.detach()
    this.outputListeners.clear()
    this.exitListeners.clear()
    try {
      try {
        if (this.pty && !this.exited && process.platform !== "win32") {
          const pid = this.pty.pid
          if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
            throw new PtyError("Cannot signal an invalid owned child PID")
          }
          // Forced disposal must also terminate stopped children; transport kill alone may not.
          process.kill(pid, "SIGKILL")
        }
      } catch (cause) {
        // Exit can race with disposal. Other failures must remain visible.
        if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ESRCH") throw cause
      } finally {
        // Always release the transport, even after exit or a failed OS signal.
        this.pty?.kill()
      }
    } finally {
      if (this.handle) freeTerminal(this.handle)
      this.handle = null
    }
  }

  private queueResponse(bytes: Uint8Array): void {
    if (this.disposed || this.exited) return
    this.responses.push(bytes)
    if (this.responseScheduled) return
    this.responseScheduled = true
    // Never call PTY write from inside Ghostty's synchronous native callback.
    queueMicrotask(() => {
      this.responseScheduled = false
      const responses = this.responses.splice(0)
      if (this.disposed || this.exited || !this.pty) return
      for (const response of responses) this.pty.write(Buffer.from(response).toString("utf8"))
    })
  }

  private trackCursor(data: string): void {
    // Cheap best-effort scan: printable runs advance x, control bytes move it.
    // Wrapped lines and scroll regions are approximated (clamp + scroll y).
    const cols = this.dimensions.cols
    const rows = this.dimensions.rows
    const clamp = () => {
      this.cursor.x = Math.max(0, Math.min(cols - 1, this.cursor.x))
      this.cursor.y = Math.max(0, Math.min(rows - 1, this.cursor.y))
    }
    const newline = () => {
      this.cursor.x = 0
      this.cursor.y += 1
      if (this.cursor.y >= rows) this.cursor.y = rows - 1 // scrolled; x unknown
    }
    let i = 0
    while (i < data.length) {
      const ch = data[i]!
      if (ch === "\x1b") {
        const rest = data.slice(i)
        let m: RegExpMatchArray | null
        if ((m = rest.match(/^\x1b\[(\d*);?(\d*)?[Hft]/))) {
          const r = m[1] ? parseInt(m[1], 10) : 1
          const c = m[2] ? parseInt(m[2], 10) : 1
          this.cursor.y = r - 1
          this.cursor.x = c - 1
          clamp()
          i += m[0].length
          continue
        }
        if ((m = rest.match(/^\x1b\[(\d*)([ABCDEFEG])/))) {
          const n = m[1] ? parseInt(m[1], 10) : 1
          switch (m[2]) {
            case "A": this.cursor.y -= n; break
            case "B": case "E": this.cursor.y += n; break
            case "C": case "G": this.cursor.x += m[2] === "G" ? 0 : n; break
            case "D": this.cursor.x -= n; break
            case "F": this.cursor.y -= n; break
          }
          if (m[2] === "E" || m[2] === "F") this.cursor.x = 0
          if (m[2] === "G") this.cursor.x = n - 1
          clamp()
          i += m[0].length
          continue
        }
        if ((m = rest.match(/^\x1b\[\?(\d+)([hl])/))) {
          const code = m[1]
          const on = m[2] === "h"
          if (code === "25") this.cursor.visible = on
          if (code === "1049") {
            this.cursor.altScreen = on
            if (on) { this.cursor.x = 0; this.cursor.y = 0 }
          }
          i += m[0].length
          continue
        }
        if (rest.startsWith("\x1b[2J")) { this.cursor.x = 0; this.cursor.y = 0; i += 4; continue }
        if (rest.startsWith("\x1b[H")) { this.cursor.x = 0; this.cursor.y = 0; i += 3; continue }
        if (rest.startsWith("\x1b7") || rest.startsWith("\x1b[s")) {
          this.savedCursor = { x: this.cursor.x, y: this.cursor.y }
          i += rest.startsWith("\x1b7") ? 2 : 3
          continue
        }
        if (rest.startsWith("\x1b8") || rest.startsWith("\x1b[u")) {
          if (this.savedCursor) { this.cursor.x = this.savedCursor.x; this.cursor.y = this.savedCursor.y }
          i += rest.startsWith("\x1b8") ? 2 : 3
          continue
        }
        if (rest.startsWith("\x1bM")) { this.cursor.y = Math.max(0, this.cursor.y - 1); i += 2; continue }
        // Unknown escape: skip the introducer so text scanning continues.
        i += 1
        continue
      }
      if (ch === "\r") { this.cursor.x = 0; i++; continue }
      if (ch === "\n") { newline(); i++; continue }
      if (ch === "\b") { this.cursor.x = Math.max(0, this.cursor.x - 1); i++; continue }
      if (ch === "\t") { this.cursor.x = Math.min(cols - 1, this.cursor.x + (8 - (this.cursor.x % 8))); i++; continue }
      // Printable (skip combining continuation widths crudely): advance one cell.
      this.cursor.x += 1
      if (this.cursor.x >= cols) { this.cursor.x = 0; this.cursor.y += 1 }
      if (this.cursor.y >= rows) this.cursor.y = rows - 1
      i++
    }
    clamp()
    // Validate against SIGWINCH-driven size: dimensions only change via resize().
  }

  private emitData(text: string): void {
    for (const listener of this.outputListeners) listener(text)
  }

  private detach(): void {
    for (const subscription of this.subscriptions) subscription.dispose()
    this.subscriptions.length = 0
  }

  private requireHandle(): Pointer {
    if (this.disposed || !this.handle) throw new PtyError("Terminal is disposed")
    return this.handle
  }

  private requirePty(): IPty {
    this.requireHandle()
    if (!this.pty) throw new PtyError("Terminal has not spawned")
    if (this.exited) throw new PtyError("Terminal has exited")
    return this.pty
  }
}
