import { describe, expect, test } from "bun:test"
import { truncate, truncateLeft, truncateMiddle } from "../../src/util/locale"

const LONG = "src/session/runner/to-llm-message.ts"
const EMOJI = "abcdef😀ghijkl"

// A lone surrogate is not valid UTF-8, so re-encoding and decoding it produces
// the replacement character. Round-tripping detects the split.
const roundTrip = (str: string) => Buffer.from(str, "utf8").toString("utf8")

describe("util.locale.truncate", () => {
  test("leaves a string that already fits alone", () => {
    expect(truncate("short", 20)).toBe("short")
    expect(truncate("exact", 5)).toBe("exact")
  })

  test("keeps the head and spends the last column on the ellipsis", () => {
    expect(truncate(LONG, 20)).toBe("src/session/runner/…")
    expect(truncate(LONG, 20)).toHaveLength(20)
  })

  test("never returns more characters than the budget", () => {
    for (let len = 0; len <= 8; len += 1) {
      expect(truncate(LONG, len).length).toBeLessThanOrEqual(len)
    }
  })

  test("collapses to a bare ellipsis when only the ellipsis fits", () => {
    expect(truncate(LONG, 0)).toBe("")
    expect(truncate(LONG, 1)).toBe("…")
  })

  test("does not cut a surrogate pair in half", () => {
    // "😀" occupies two UTF-16 units at index 6-7, so a budget of 8 would land
    // the cut inside it; the pair must be dropped whole rather than orphaned.
    expect(truncate(EMOJI, 8)).toBe("abcdef…")
    expect(truncate(EMOJI, 8)).toBe(roundTrip(truncate(EMOJI, 8)))
  })
})

describe("util.locale.truncateLeft", () => {
  test("leaves a string that already fits alone", () => {
    expect(truncateLeft("short", 20)).toBe("short")
  })

  test("keeps the tail and spends the first column on the ellipsis", () => {
    expect(truncateLeft(LONG, 20)).toBe("…r/to-llm-message.ts")
    expect(truncateLeft(LONG, 20)).toHaveLength(20)
  })

  test("never returns more characters than the budget", () => {
    for (let len = 0; len <= 8; len += 1) {
      expect(truncateLeft(LONG, len).length).toBeLessThanOrEqual(len)
    }
  })

  test("collapses to a bare ellipsis when only the ellipsis fits", () => {
    expect(truncateLeft(LONG, 0)).toBe("")
    expect(truncateLeft(LONG, 1)).toBe("…")
  })

  test("does not cut a surrogate pair in half", () => {
    // The emoji sits at UTF-16 index 6-7, so a budget of 8 would keep the last 7
    // units and start on its low half; the whole pair has to go instead.
    expect(truncateLeft(EMOJI, 8)).toBe("…ghijkl")
    expect(truncateLeft(EMOJI, 8)).toBe(roundTrip(truncateLeft(EMOJI, 8)))
  })
})

describe("util.locale.truncateMiddle", () => {
  test("leaves a string that already fits alone", () => {
    expect(truncateMiddle("short")).toBe("short")
    expect(truncateMiddle("short", 5)).toBe("short")
  })

  test("splits the budget around a single ellipsis", () => {
    expect(truncateMiddle(LONG, 20)).toBe("src/sessio…essage.ts")
    expect(truncateMiddle(LONG, 20)).toHaveLength(20)
    expect(truncateMiddle(LONG, 12)).toBe("src/se…ge.ts")
  })

  test("never returns more characters than the budget", () => {
    // Callers clamp widths with Math.max(1, ...) and some pass a raw measured
    // width, so budgets of 0, 1 and 2 all reach this function in practice.
    for (let maxLength = 0; maxLength <= 10; maxLength += 1) {
      const out = truncateMiddle(LONG, maxLength)
      expect(out.length).toBeLessThanOrEqual(maxLength)
    }
  })

  test("collapses to a bare ellipsis when only the ellipsis fits", () => {
    expect(truncateMiddle(LONG, 0)).toBe("")
    expect(truncateMiddle(LONG, 1)).toBe("…")
    expect(truncateMiddle(LONG, 2)).toBe("s…")
  })

  test("does not cut a surrogate pair in half", () => {
    for (let maxLength = 1; maxLength <= 14; maxLength += 1) {
      const out = truncateMiddle(EMOJI, maxLength)
      expect(out).toBe(roundTrip(out))
      expect(out.length).toBeLessThanOrEqual(maxLength)
    }
  })
})
