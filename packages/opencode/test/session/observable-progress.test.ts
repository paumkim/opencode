import { describe, expect, test } from "bun:test"
import { ObservableProgress, observationSignature, type Observation } from "../../src/session/observable-progress"

const read = (input: unknown = { filePath: "a", offset: 1, limit: 10 }, result = "same"): Observation => ({
  tool: "read", input, status: "completed", result,
})

describe("observable progress", () => {
  test("full stable arguments and result/error signatures", () => {
    expect(observationSignature(read({ a: 1, b: { x: 2, y: 3 } }))).toBe(
      observationSignature(read({ b: { y: 3, x: 2 }, a: 1 })),
    )
    expect(observationSignature(read())).not.toBe(observationSignature(read(undefined, "changed")))
    expect(observationSignature(read())).not.toBe(observationSignature({ ...read(), status: "error" }))
  })

  test("repeated read nudges after three repeat-only turns then stops after two more", () => {
    const guard = new ObservableProgress()
    expect(Array.from({ length: 6 }, () => guard.turn([read()]))).toEqual([
      "continue", "continue", "continue", "nudge", "continue", "stop",
    ])
  })

  test("A/B cycle is bounded across turns", () => {
    const guard = new ObservableProgress()
    expect(Array.from({ length: 7 }, (_, i) => guard.turn([read({ filePath: i % 2 ? "b" : "a" })]))).toEqual([
      "continue", "continue", "continue", "continue", "nudge", "continue", "stop",
    ])
  })

  test("different queries, read ranges, results and tools are evidence without edits", () => {
    const guard = new ObservableProgress()
    for (let i = 0; i < 20; i++) {
      expect(guard.turn([{ ...read({ query: String(i) }), tool: "search" }])).toBe("continue")
      expect(guard.turn([read({ offset: i, limit: 10 })])).toBe("continue")
      expect(guard.turn([read(undefined, String(i))])).toBe("continue")
    }
  })

  test("new evidence resets recovery; real input resets history", () => {
    const guard = new ObservableProgress()
    guard.user("one")
    for (let i = 0; i < 4; i++) guard.turn([read()])
    expect(guard.turn([read(undefined, "new")])).toBe("continue")
    expect(guard.turn([read()])).toBe("continue")
    guard.user("two")
    expect(guard.turn([read()])).toBe("continue")
    expect(guard.turn([read()])).toBe("continue")
    expect(guard.turn([read()])).toBe("continue")
    expect(guard.turn([read()])).toBe("nudge")
  })

  test("synthetic input and compaction do not reset", () => {
    const guard = new ObservableProgress()
    guard.user("one")
    for (let i = 0; i < 4; i++) guard.turn([read()])
    guard.user("one")
    guard.user(undefined)
    expect(guard.turn([])).toBe("continue")
    expect(guard.turn([read()])).toBe("continue")
    expect(guard.turn([read()])).toBe("stop")
  })

  test("different failed edit attempts do not count as progress", () => {
    const guard = new ObservableProgress()
    expect(Array.from({ length: 5 }, (_, i) => guard.turn([{
      tool: "edit", input: { filePath: "a", newString: String(i) }, status: "error", result: `failure ${i}`,
    }]))).toEqual(["continue", "continue", "nudge", "continue", "stop"])
  })

  test("opt out and configurable thresholds", () => {
    const disabled = new ObservableProgress({ enabled: false })
    for (let i = 0; i < 30; i++) expect(disabled.turn([read()])).toBe("continue")
    const guard = new ObservableProgress({ repeat_turns: 1, recovery_turns: 1 })
    expect(guard.turn([read()])).toBe("continue")
    expect(guard.turn([read()])).toBe("nudge")
    expect(guard.turn([read()])).toBe("stop")
  })

  test("new failures cannot evict an unchanged successful read", () => {
    const guard = new ObservableProgress()
    const decisions = Array.from({ length: 20 }, (_, turn) => guard.turn([
      ...Array.from({ length: 12 }, (_, i): Observation => ({
        tool: "edit", input: { turn, i }, status: "error", result: `failure ${turn}/${i}`,
      })),
      read(),
    ]))
    expect(decisions.slice(0, 6)).toEqual(["continue", "continue", "continue", "nudge", "continue", "stop"])
  })

  test("identical 13-read batches cannot evict themselves", () => {
    const guard = new ObservableProgress()
    const batch = Array.from({ length: 13 }, (_, i) => read({ offset: i }))
    const decisions = Array.from({ length: 20 }, () => guard.turn(batch))
    expect(decisions.slice(0, 6)).toEqual(["continue", "continue", "continue", "nudge", "continue", "stop"])
  })

  test("13-call cycles cannot buy unlimited recovery", () => {
    const guard = new ObservableProgress()
    const decisions = Array.from({ length: 100 }, (_, i) => guard.turn([read({ offset: i % 13 })]))
    expect(decisions.indexOf("nudge")).toBe(15)
    expect(decisions.indexOf("stop")).toBe(17)
  })
})
