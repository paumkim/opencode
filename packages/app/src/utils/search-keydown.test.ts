import { describe, expect, test } from "bun:test"
import { handleDocumentSearchKeydown } from "./search-keydown"

// The handler exists for keypresses that land while the search input is not
// focused, so it reads the caret off the live element. Both have to agree with
// the value passed in, or the caret is read from stale element state.
function press(key: string, value: string, caret: number) {
  const input = document.createElement("input")
  document.body.appendChild(input)
  input.value = value
  input.setSelectionRange(caret, caret)
  let next = value
  const handled = handleDocumentSearchKeydown(
    input,
    new KeyboardEvent("keydown", { key, bubbles: true }),
    value,
    (updated) => (next = updated),
  )
  return { handled, next, caret: input.selectionStart }
}

const hasLoneSurrogate = (value: string) => /[\uD800-\uDFFF]/.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))

// "deploy 🚀x" — the rocket occupies code units 7 and 8.
const EMOJI = "deploy 🚀x"

describe("handleDocumentSearchKeydown", () => {
  test("inserts an astral character that is two UTF-16 code units", () => {
    // "😀" is one code point but two code units, so a `key.length === 1` guard
    // silently discarded the keypress.
    expect(press("😀", "", 0).next).toBe("😀")
    expect(press("😀", "a", 1).next).toBe("a😀")
    expect(press("😀", "a😀", 3).next).toBe("a😀😀")
  })

  test("backspace deletes a whole code point", () => {
    // Caret 9 is just after the pair: one unit back lands inside it.
    const { next } = press("Backspace", EMOJI, 9)
    expect(next).toBe("deploy x")
    expect(hasLoneSurrogate(next)).toBe(false)
  })

  test("delete removes a whole code point", () => {
    // Caret 7 is just before the pair: one unit forward lands inside it.
    const { next } = press("Delete", EMOJI, 7)
    expect(next).toBe("deploy x")
    expect(hasLoneSurrogate(next)).toBe(false)
  })

  test("backspace deletes a whole code point mid-value", () => {
    const { next } = press("Backspace", "a😀b", 3)
    expect(next).toBe("ab")
    expect(hasLoneSurrogate(next)).toBe(false)
  })

  test("arrow keys step over a whole code point", () => {
    expect(press("ArrowLeft", EMOJI, 9).caret).toBe(7)
    expect(press("ArrowRight", EMOJI, 7).caret).toBe(9)
    // Plain characters still step by one.
    expect(press("ArrowLeft", EMOJI, 9).caret).not.toBe(8)
    expect(press("ArrowLeft", "abc", 2).caret).toBe(1)
  })

  test("still handles plain keys, deletion, and unhandled keys", () => {
    expect(press("a", "", 0).next).toBe("a")
    expect(press("Backspace", "ab", 2).next).toBe("a")
    expect(press("Delete", "ab", 0).next).toBe("b")
    expect(press("Enter", "ab", 2).handled).toBe(false)
    expect(press("Shift", "ab", 2).handled).toBe(false)
    // More than one code point is not a single keystroke.
    expect(press("ab", "", 0).handled).toBe(false)
  })
})
