import { cc, CString, dlopen, FFIType, JSCallback, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
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
  const nativeDir = dirname(path)
  // Resolve build resources from the selected native library, not import.meta.url:
  // compiled Bun modules report /$bunfs/root paths that the system C compiler
  // cannot open.
  return cc({
    source: join(nativeDir, "formatter.c"),
    include: [join(nativeDir, "include")],
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
  
  // 1. Explicit override for bundled/portable deployments.
  const envPath = process.env.GHOSTTY_NATIVE_PATH
  if (envPath && existsSync(envPath)) return envPath
  
  // 2. Source-relative path (works in dev/test from the package directory).
  const sourceRelative = fileURLToPath(new URL(`../../native/${filename}`, import.meta.url))
  if (existsSync(sourceRelative)) return sourceRelative
  
  // 2a. Bundled-virtual-path guard: if import.meta.url resolved to a virtual
  //     location (e.g. file:///src/ffi/bindings.ts), the source-relative path
  //     will be nonsense like /native/libghostty-vt.so. Detect that and fall
  //     back to the well-known package-relative location.
  if (sourceRelative.startsWith("/native/") || sourceRelative.startsWith("/src/")) {
    const known = fileURLToPath(new URL(`../../native/${filename}`, new URL("file:///home/pauk/Projects/opencode/packages/ghostty-terminal/src/ffi/bindings.ts")))
    if (existsSync(known)) return known
  }
  
  // 3. Binary-relative fallback: from the running executable, walk up to the
  //    repo root then into packages/ghostty-terminal/native/.
  try {
    const execPath = process.execPath
    const binDir = dirname(execPath)
    const parts = binDir.split(sep)
    const distIdx = parts.lastIndexOf("dist")
    if (distIdx >= 0 && parts[distIdx + 1]?.includes("opencode") && parts[distIdx + 2] === "bin") {
      // The binary lives at <repoRoot>/packages/opencode/dist/<platform>/bin/opencode.
      // Walk up from bin/ to the repo root: bin -> platform -> dist -> opencode -> packages -> repoRoot
      const repoRoot = join(binDir, "..", "..", "..", "..", "..")
      const binaryRelative = join(repoRoot, "packages", "ghostty-terminal", "native", filename)
      if (existsSync(binaryRelative)) return binaryRelative
    }
  } catch {
    // ignore path-walk failures and fall through
  }
  
  // 4. Last resort: return the source-relative path and let dlopen fail with a clear error.
  return sourceRelative
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
