/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { mayWriteStore } from "../../../../src/context/local"

let restore: (() => void) | undefined

function captureConsole() {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "))
  }
  restore = () => {
    console.error = original
  }
  return lines
}

afterEach(() => {
  restore?.()
  restore = undefined
})

describe("mayWriteStore", () => {
  test("refuses when the file was not read, and says what was at stake", () => {
    // The defect, in one decision. Both stores in local.tsx default to EMPTY - no recent models, no
    // favourites, no pinned sessions - which is indistinguishable from a store that was read and
    // genuinely is empty. A failed read followed by any save therefore wrote the defaults over a file
    // holding real data, and the write succeeded, so nothing was reported.
    const lines = captureConsole()
    expect(mayWriteStore("/state/model.json", false, "the models and favourites it holds")).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("/state/model.json")
    // The consequence, not just "the file was not read": this is what tells a user their settings
    // are not being saved.
    expect(lines[0]).toContain("would erase the models and favourites it holds")
  })

  test("allows the write once the file has been read", () => {
    // The direction that must not regress: refusing here would stop every preference in the TUI
    // from being saved, which is a far worse bug than the one being fixed.
    const lines = captureConsole()
    expect(mayWriteStore("/state/model.json", true, "the models and favourites it holds")).toBe(true)
    expect(lines).toEqual([])
  })

  test("names the pinned sessions for the session store, not the model store's subject", () => {
    // The two stores share the guard but not the subject, and a message that named the wrong one
    // would send a reader to the wrong file.
    const lines = captureConsole()
    expect(mayWriteStore("/state/session.json", false, "the pinned sessions it holds")).toBe(false)
    expect(lines[0]).toContain("/state/session.json")
    expect(lines[0]).toContain("pinned sessions")
  })

  test("both stores route their save through this guard", async () => {
    // `mayWriteStore` is a pure decision, so testing it alone does not prove either store uses it -
    // and the eighth time this goal that distinction has cost a green suite that proved nothing. The
    // stores are Solid signals behind eleven context providers; mounting them is a much larger
    // change than the two-line guard, so the wiring is checked against the source instead. A blunt
    // instrument, and better than claiming coverage I do not have.
    const source = await Bun.file(new URL("../../../../src/context/local.tsx", import.meta.url)).text()
    const guards = source.match(/if \(!mayWriteStore\(/g) ?? []
    // Once for the model store, once for the session store.
    expect(guards).toHaveLength(2)
    // And each guarded write is preceded by the check, rather than the guard existing while the
    // write still runs unconditionally. Matching the window between guard and write is what makes
    // this a wiring test rather than a count of a name.
    for (const body of ["recent: modelStore.recent", "pinned: sessionStore.pinned"]) {
      const at = source.indexOf(body)
      expect(at).toBeGreaterThan(0)
      const before = source.slice(Math.max(0, at - 400), at)
      expect(before).toContain("mayWriteStore")
    }
  })
})
