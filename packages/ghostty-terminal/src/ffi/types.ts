export interface TerminalOpts {
  cwd?: string
  env?: Record<string, string>
  cols: number
  rows: number
  name?: string
}

/** TUI-critical env keys the OpenTUI Solid renderer depends on. */
export const TUI_ENV_DEFAULTS = {
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  LANG: "C.UTF-8",
} as const

/** Keys passed through from the host when the caller did not set them. */
export const TUI_ENV_PASSTHROUGH = [
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "TERM_PROGRAM",
  "COLORFGBG",
] as const

/** Opt-in input framing for write(). Default is raw passthrough. */
export interface WriteOpts {
  /** Wrap data in bracketed-paste markers (CSI 200~ ... CSI 201~). */
  bracketedPaste?: boolean
}

/** Opt-in screen fidelity knobs. Defaults preserve existing trim behavior. */
export interface ScreenOpts {
  /** Pad each plain-text line with trailing spaces to the viewport width. */
  preserveTrailingSpace?: boolean
}

/** Best-effort cursor/alt-screen state tracked from the VT output stream. */
export interface CursorState {
  /** 0-based viewport column. */
  x: number
  /** 0-based viewport row. */
  y: number
  /** False after DECTCEM hide (CSI ? 25 l). */
  visible: boolean
  /** True while DEC1049 alt-screen is active. */
  altScreen: boolean
}

/** Structured viewport snapshot; text/html match readScreen() output. */
export interface ScreenState {
  text: string
  html: string
  cursor: CursorState
  cols: number
  rows: number
}

export interface PtyLike {
  readonly pid: number
  onData(fn: (data: string) => void): { dispose: () => void }
  onExit(fn: (event: ExitEvent) => void): { dispose: () => void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  dispose(): void
}

export interface ExitEvent {
  exitCode: number
  /** OS signal name/number as reported by the PTY transport (e.g. "SIGTERM"). */
  signal?: number | string
  /** Compatibility alias for exitCode. */
  code: number
}
