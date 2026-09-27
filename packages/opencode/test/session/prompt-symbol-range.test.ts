import { describe, expect, test } from "bun:test"
import { expandToSymbol, symbolLineRange } from "@/session/prompt-symbol-range"

// LSP positions are zero-based and an LSP range end is exclusive. The selection
// the app sends, and the Read tool's `offset`, are both one-based.
const pos = (line: number, character = 0) => ({ line, character })

describe("symbolLineRange", () => {
  test("converts a zero-based range to a one-based inclusive span", () => {
    // Zero-based lines 4..9 (five lines) are one-based lines 5..10.
    expect(symbolLineRange({ start: pos(4), end: pos(9, 12) })).toEqual({ start: 5, end: 10 })
  })

  test("a zero-based start line of 0 is the first line, not no line", () => {
    expect(symbolLineRange({ start: pos(0), end: pos(2, 3) })).toEqual({ start: 1, end: 3 })
  })

  test("an exclusive end at the start of a line does not include that line", () => {
    // Ends at zero-based line 8 char 0, so the last line covered is 7.
    expect(symbolLineRange({ start: pos(4), end: pos(8, 0) })).toEqual({ start: 5, end: 8 })
  })

  test("an exclusive end mid-line does include that line", () => {
    expect(symbolLineRange({ start: pos(4), end: pos(8, 1) })).toEqual({ start: 5, end: 9 })
  })

  test("a single-line symbol is one line wide, not zero", () => {
    expect(symbolLineRange({ start: pos(6, 2), end: pos(6, 9) })).toEqual({ start: 7, end: 7 })
  })

  test("never ends before it starts", () => {
    expect(symbolLineRange({ start: pos(6), end: pos(6, 0) })).toEqual({ start: 7, end: 7 })
  })
})

describe("expandToSymbol", () => {
  const symbol = (start: number, end: number, endChar = 1) => ({
    range: { start: pos(start), end: pos(end, endChar) },
  })

  test("matches on the one-based start line", () => {
    const span = expandToSymbol([symbol(4, 9)], 5)
    expect(span).toEqual({ start: 5, end: 10 })
  })

  test("does not match a symbol one line away", () => {
    expect(expandToSymbol([symbol(4, 9)], 6)).toBeUndefined()
    expect(expandToSymbol([symbol(4, 9)], 4)).toBeUndefined()
  })

  test("expands a symbol that starts on the first line", () => {
    expect(expandToSymbol([symbol(0, 3)], 1)).toEqual({ start: 1, end: 4 })
  })

  test("reads a symbol location as well as a range", () => {
    expect(expandToSymbol([{ location: { range: { start: pos(4), end: pos(9, 2) } } }], 5)).toEqual({
      start: 5,
      end: 10,
    })
  })

  test("returns undefined when no symbol starts there", () => {
    expect(expandToSymbol([], 5)).toBeUndefined()
    expect(expandToSymbol([{ location: {} } as never], 5)).toBeUndefined()
  })

  test("picks the first symbol starting on the line", () => {
    const span = expandToSymbol([symbol(4, 4), symbol(4, 20)], 5)
    expect(span).toEqual({ start: 5, end: 5 })
  })
})
