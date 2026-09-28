import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { readTaskSession } from "@/tool/task"
import { NotFoundError } from "@/storage/storage"

const found = <A>(value: A) => Effect.succeed(value)
// `Session.get` fails with this when the row is genuinely absent.
const notFound = Effect.fail(new NotFoundError({ message: "Session not found: ses_gone" }))
// A storage or transport failure surfaces as a defect, not as a `NotFound`.
const readFailed = Effect.die(new Error("storage unavailable"))

// The task tool resolved the child session with `catchCause(() => undefined)`,
// which swallowed both a genuinely missing task and a read that failed. The
// caller then did `session ?? sessions.create(...)`, so the second case handed
// the agent a blank subagent: the work was redone from scratch and the prior
// transcript was orphaned with nothing reporting a problem. Forgiving on a
// stale id is documented and tested behaviour; forgiving on a failed read was
// the defect.

describe("readTaskSession", () => {
  test("returns the session when the task exists", async () => {
    const session = { id: "ses_child" }
    expect(await Effect.runPromise(readTaskSession("ses_child", found(session)))).toEqual(session)
  })

  // Documented, tested behaviour: a stale task_id still lets the work proceed.
  test("resolves to undefined for a task that genuinely does not exist", async () => {
    expect(await Effect.runPromise(readTaskSession("ses_gone", notFound))).toBeUndefined()
  })

  // The regression: this used to resolve to undefined too, and the caller
  // created a fresh session as though no task_id had been passed at all.
  test("does not resolve to undefined when the read itself failed", async () => {
    const exit = await Effect.runPromiseExit(readTaskSession("ses_child", readFailed))
    expect(exit._tag).toBe("Failure")
  })

  test("keeps the underlying reason visible when the read fails", async () => {
    const exit = await Effect.runPromiseExit(readTaskSession("ses_child", readFailed))
    const rendered = exit._tag === "Failure" ? String(exit.cause) : ""
    expect(rendered).toContain("storage unavailable")
  })
})
