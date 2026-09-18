import { describe, it, expect, afterAll } from "bun:test"
import { fileURLToPath } from "node:url"
import {
  isSupported, getNativePath, loadLibrary, unloadLibrary,
  createTerminal, writeTerminal, formatTerminalText, freeTerminal,
} from "../src/ffi/bindings"
import { detectPlatform } from "../src/build/detect"

// Native proof: missing libraries, headers, symbols and ABI failures must fail.
afterAll(() => unloadLibrary())

describe("ghostty-terminal FFI", () => {
  it("detects platform", () => {
    const platform = detectPlatform()
    expect(platform.platform).toBe(process.platform)
    expect(platform.arch).toBe(process.arch)
    expect(platform.zigTarget).toBeTruthy()
    expect(platform.libraryFilename).toBeTruthy()
  })

  it("uses bun:ffi and resolves the package native directory", () => {
    expect(isSupported()).toBe(true)
    expect(getNativePath()).toBe(fileURLToPath(new URL(`../native/${detectPlatform().libraryFilename}`, import.meta.url)))
    expect(loadLibrary().path).toBe(getNativePath())
  })

  it("formats real Ghostty state after SGR, CUP, overwrite and split UTF-8 input", () => {
    const terminal = createTerminal(20, 4)
    try {
      // SGR red, move to row 2 column 5, then overwrite row 1 column 2.
      const bytes = new TextEncoder().encode("\x1b[31mRED\x1b[0m\x1b[2;5Hcafé")
      writeTerminal(terminal, bytes.subarray(0, bytes.length - 1))
      writeTerminal(terminal, bytes.subarray(bytes.length - 1))
      writeTerminal(terminal, new TextEncoder().encode("\x1b[1;2H!"))
      expect(formatTerminalText(terminal, 20, 4)).toBe("R!D\n    café")
      writeTerminal(terminal, new Uint8Array())
      writeTerminal(terminal, new TextEncoder().encode("\x1b[2;1HOK"))
      expect(formatTerminalText(terminal, 20, 4)).toBe("R!D\nOK  café")
    } finally {
      freeTerminal(terminal)
    }
  })

  it("frees empty formatted output and rejects invalid dimensions", () => {
    expect(() => createTerminal(0, 4)).toThrow(RangeError)
    expect(() => createTerminal(65536, 4)).toThrow(RangeError)
    const terminal = createTerminal(20, 4)
    try {
      expect(formatTerminalText(terminal, 20, 4)).toBe("")
    } finally {
      freeTerminal(terminal)
    }
  })
})
