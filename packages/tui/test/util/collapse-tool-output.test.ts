import { describe, expect, test } from "bun:test"
import { collapseToolOutput } from "../../src/util/collapse-tool-output"

// `maxChars` is a character budget derived from terminal width, but the
// implementation measured and cut it in UTF-16 code units. An emoji is two
// units, so output was cut roughly half as early as the bound allows, and a cut
// landing between the halves of a pair left a LONE SURROGATE. That serializes to
// a `\udXXX` escape which a renderer reads back as U+FFFD, so the preview showed
// a replacement glyph where the last character should be.

describe("collapseToolOutput", () => {
  test("leaves short output untouched", () => {
    const out = "one\ntwo"
    expect(collapseToolOutput(out, 3, 100)).toEqual({ output: out, overflow: false })
  })

  test("truncates on line count and marks overflow", () => {
    const out = "one\ntwo\nthree\nfour"
    const result = collapseToolOutput(out, 2, 1000)
    expect(result.overflow).toBe(true)
    expect(result.output).toBe("one\ntwo\n…")
  })

  test("truncates on the character budget and marks overflow", () => {
    const result = collapseToolOutput("abcdefghij", 5, 5)
    expect(result.overflow).toBe(true)
    expect(result.output).toBe("abcd…")
  })

  describe("astral characters", () => {
    // A lone surrogate is the real failure: it is invisible in a JS string but
    // becomes U+FFFD once serialized, which is how tool output reaches the UI.
    const hasLoneSurrogate = (value: string) => {
      for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i)
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = value.charCodeAt(i + 1)
          if (!(next >= 0xdc00 && next <= 0xdfff)) return true
          i++
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          return true
        }
      }
      return false
    }

    for (let maxChars = 1; maxChars <= 8; maxChars++) {
      test(`a ${maxChars}-character budget never splits a surrogate pair`, () => {
        const input = "😀😀😀😀"
        const result = collapseToolOutput(input, 10, maxChars)
        expect(hasLoneSurrogate(result.output)).toBe(false)
        // And it survives a JSON round trip unchanged, which is the path that
        // turned the lone surrogate into U+FFFD.
        expect(JSON.parse(JSON.stringify(result.output))).toBe(result.output)
      })
    }

    test("the budget counts characters, not code units", () => {
      // 5 emoji are 5 characters and 10 code units, with a budget of 4. Counting
      // characters keeps 3 emoji plus the ellipsis; counting units would keep
      // only 1 and cut the preview off long before the bound allows.
      const result = collapseToolOutput("😀😀😀😀😀", 10, 4)
      expect(result.overflow).toBe(true)
      expect(result.output).toBe("😀😀😀…")
      expect([...result.output].length).toBe(4)
      // The unit-counting bug produced this instead.
      expect(result.output).not.toBe("😀…")
    })

    test("output that exactly fits is not marked as overflow", () => {
      const result = collapseToolOutput("😀😀😀😀", 10, 4)
      expect(result.overflow).toBe(false)
      expect(result.output).toBe("😀😀😀😀")
    })

    test("mixed ASCII and emoji cut cleanly", () => {
      const result = collapseToolOutput("ab😀cd😀ef", 10, 6)
      expect(result.overflow).toBe(true)
      expect(hasLoneSurrogate(result.output)).toBe(false)
      expect([...result.output].length).toBeLessThanOrEqual(6)
    })
  })

  describe("degenerate budgets", () => {
    test("a zero budget yields just the ellipsis", () => {
      const result = collapseToolOutput("abcdef", 10, 0)
      expect(result.output).toBe("…")
      expect(result.overflow).toBe(true)
    })

    test("a one-character budget yields just the ellipsis", () => {
      const result = collapseToolOutput("abcdef", 10, 1)
      expect(result.output).toBe("…")
      expect(result.overflow).toBe(true)
    })

    test("an empty string does not overflow", () => {
      expect(collapseToolOutput("", 3, 3)).toEqual({ output: "", overflow: false })
    })
  })
})
