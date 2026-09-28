import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { readTypedList } from "@/cli/cmd/run/stream.transport"

// The generated SDK client resolves typed HTTP failures into `.error` rather
// than rejecting, so the old `Effect.orElseSucceed(() => [])` only ever caught
// transport errors. A 404, 500 or timeout resolved with `data: undefined` and
// `?? []` became an authoritative empty list — and for `permission.list` and
// `question.list` that meant a session with a blocked agent showing no prompt
// at all, and no way for the user to answer it.
const ok = <A>(data: A) => Effect.succeed({ data })
const typedFailure = (error: { message: string }) => Effect.succeed({ data: undefined, error })
const transportFailure = Effect.die("transport exploded")

describe("readTypedList", () => {
  test("returns the data when the read succeeded", async () => {
    expect(await Effect.runPromise(readTypedList(ok(["a", "b"]), []))).toEqual(["a", "b"])
  })

  // The regression: a typed failure resolved with no data, so the old code
  // reported "nothing pending" for a session that did have one waiting.
  test("fails on a typed HTTP failure instead of reporting an empty list", async () => {
    expect(Exit.isFailure(await Effect.runPromiseExit(readTypedList(typedFailure({ message: "boom" }), [])))).toBe(true)
  })

  test("keeps a genuinely empty list as empty, not a failure", async () => {
    expect(await Effect.runPromise(readTypedList(ok([]), ["stale"]))).toEqual([])
  })

  test("falls back when a successful read carried no data", async () => {
    expect(await Effect.runPromise(readTypedList(ok(undefined as never), ["fallback"]))).toEqual(["fallback"])
  })

  // A transport rejection is a defect and still propagates. The old code turned
  // it into `[]` too, which is the same authoritative-empty lie.
  test("still propagates a transport failure", async () => {
    expect(Exit.isFailure(await Effect.runPromiseExit(readTypedList(transportFailure, [])))).toBe(true)
  })
})
