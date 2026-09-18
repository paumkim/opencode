import { cc, CString, dlopen, FFIType, JSCallback, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { FfiError } from "../error/errors.js"

const symbols = {
  ghostty_terminal_new: { returns: FFIType.i32, args: [FFIType.ptr, FFIType.ptr, FFIType.u16, FFIType.u16] },
  ghostty_terminal_free: { returns: FFIType.void, args: [FFIType.ptr] },
  ghostty_terminal_resize: { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u16, FFIType.u16, FFIType.u32, FFIType.u32] },
  ghostty_terminal_set: { returns: FFIType.i32, args: [FFIType.ptr, FFIType.i32, FFIType.ptr] },
  ghostty_terminal_vt_write: { returns: FFIType.void, args: [FFIType.ptr, FFIType.ptr, FFIType.u64] },
  ghostty_terminal_scroll_viewport: { returns: FFIType.void, args: [FFIType.ptr, FFIType.ptr] },
  ghostty_formatter_format_alloc: { returns: FFIType.i32, args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr] },
  ghostty_formatter_free: { returns: FFIType.void, args: [FFIType.ptr] },
  ghostty_free: { returns: FFIType.void, args: [FFIType.ptr, FFIType.ptr, FFIType.u64] },
} as const

const terminals = new Map<Pointer, JSCallback | null>()
let libInstance: { dl: ReturnType<typeof openLibrary>; path: string } | null = null
let shimInstance: ReturnType<typeof openShim> | null = null
function openLibrary(path: string) {
  return dlopen(path, symbols)
}

function openShim(path: string) {
  // Header-checked adapter for the options struct passed by value.
  return cc({
    source: fileURLToPath(new URL("./formatter.c", import.meta.url)),
    include: [fileURLToPath(new URL("../../native/include", import.meta.url))],
    flags: [`-L${dirname(path)}`],
    library: ["ghostty-vt"],
    symbols: {
      ghostty_bun_format_screen: {
        args: [FFIType.ptr, FFIType.bool, FFIType.u16, FFIType.u16, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    },
  })
}

export function isSupported(): boolean {
  return typeof Bun !== "undefined" && typeof dlopen === "function"
}

export function getNativePath(): string {
  const filename = process.platform === "darwin" ? "libghostty-vt.dylib"
    : process.platform === "win32" ? "ghostty-vt.dll" : "libghostty-vt.so"
  return fileURLToPath(new URL(`../../native/${filename}`, import.meta.url))
}

export function loadLibrary() {
  if (libInstance) return libInstance
  const path = getNativePath()
  try {
    libInstance = { dl: openLibrary(path), path }
    return libInstance
  } catch (cause) {
    throw new FfiError(`Failed to load libghostty-vt from ${path}`, cause)
  }
}

export function unloadLibrary(): void {
  if (terminals.size) throw new FfiError("Cannot unload Ghostty with live terminals")
  shimInstance?.close()
  shimInstance = null
  libInstance?.dl.close()
  libInstance = null
}

function check(result: number, operation: string): void {
  if (result !== 0) throw new FfiError(`${operation} failed: GhosttyResult ${result}`)
}

export function validateDimensions(cols: number, rows: number): void {
  for (const value of [cols, rows]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new RangeError("Terminal dimensions must be integers from 1 to 65535")
    }
  }
}

function requireTerminal(terminal: Pointer): void {
  if (!terminals.has(terminal)) throw new FfiError("Terminal is freed or not owned by these bindings")
}

export function createTerminal(cols: number, rows: number): Pointer {
  validateDimensions(cols, rows)
  const library = loadLibrary()
  // Fail before allocating/spawning if headers or the formatter ABI are unavailable.
  shimInstance ??= openShim(library.path)
  const out = new BigUint64Array(1)
  check(library.dl.symbols.ghostty_terminal_new(null, ptr(out), cols, rows), "ghostty_terminal_new")
  const terminal = read.ptr(ptr(out)) as Pointer
  if (!terminal) throw new FfiError("ghostty_terminal_new returned a null handle")
  terminals.set(terminal, null)
  return terminal
}

/** The receiver must only queue these copied bytes, not reenter Ghostty or a PTY. */
export function setWritePty(terminal: Pointer, receive: (data: Uint8Array) => void): void {
  requireTerminal(terminal)
  const callback = new JSCallback((_terminal: Pointer, _userdata: Pointer, data: Pointer, len: number | bigint) => {
    if (Number(len)) receive(new Uint8Array(toArrayBuffer(data, 0, Number(len))).slice())
  }, { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.void })
  try {
    // GHOSTTY_TERMINAL_OPT_WRITE_PTY = 1; terminal.h:1109, callback signature :1045.
    check(loadLibrary().dl.symbols.ghostty_terminal_set(terminal, 1, callback.ptr), "ghostty_terminal_set(WRITE_PTY)")
  } catch (cause) {
    callback.close()
    throw cause
  }
  terminals.get(terminal)?.close()
  terminals.set(terminal, callback)
}

export function writeTerminal(terminal: Pointer, data: Uint8Array): void {
  requireTerminal(terminal)
  if (data.byteLength) loadLibrary().dl.symbols.ghostty_terminal_vt_write(terminal, ptr(data), data.byteLength)
}

export function resizeTerminal(terminal: Pointer, cols: number, rows: number): void {
  requireTerminal(terminal)
  validateDimensions(cols, rows)
  check(loadLibrary().dl.symbols.ghostty_terminal_resize(terminal, cols, rows, 0, 0), "ghostty_terminal_resize")
}

export function formatTerminalText(terminal: Pointer, cols: number, rows: number): string {
  return formatTerminal(terminal, false, cols, rows)
}

export function formatTerminalHtml(terminal: Pointer, cols: number, rows: number): string {
  return formatTerminal(terminal, true, cols, rows)
}

/** Copies the visible viewport into JS and releases the native allocation on all paths. */
function formatTerminal(terminal: Pointer, html: boolean, cols: number, rows: number): string {
  requireTerminal(terminal)
  const { dl, path } = loadLibrary()
  const shim = shimInstance ??= openShim(path)
  const output = new BigUint64Array(1)
  const length = new BigUint64Array(1)
  check(
    shim.symbols.ghostty_bun_format_screen(terminal, html, cols, rows, ptr(output), ptr(length)),
    "ghostty_bun_format_screen",
  )
  const data = read.ptr(ptr(output)) as Pointer
  const size = length[0]!
  try {
    if (size === 0n) return ""
    if (!data || size > BigInt(Number.MAX_SAFE_INTEGER)) throw new FfiError("Invalid formatter output")
    return new CString(data, 0, Number(size)).toString()
  } finally {
    dl.symbols.ghostty_free(null, data, size)
  }
}

export function freeTerminal(terminal: Pointer): void {
  if (!terminals.has(terminal)) return
  // The terminal must stop referencing executable callback memory before closing it.
  loadLibrary().dl.symbols.ghostty_terminal_free(terminal)
  terminals.get(terminal)?.close()
  terminals.delete(terminal)
}
