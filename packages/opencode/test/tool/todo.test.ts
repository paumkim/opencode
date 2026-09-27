import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionTodo } from "@opencode-ai/schema/session-todo"
import { Parameters as TodoWriteParameters } from "@/tool/todo"

const decode = Schema.decodeUnknownSync(TodoWriteParameters)

// The parameter types are the contract's, so these tests below that deliberately feed the decoder a
// value OUTSIDE the set can still express it - the cast is at the boundary, so each case reads as
// the literal it is testing rather than as a widened string.
const todos = (status: string, priority: string = "medium") => [
  { content: "ship it", status: status as SessionTodo.Info["status"], priority: priority as SessionTodo.Info["priority"] },
]

describe("todowrite rejects a status the UI cannot read", () => {
  // The defect was not that a bad value was stored - it was that a bad value was stored SILENTLY.
  // `status` was a bare `Schema.String` whose description named four states, so the model was told
  // to pick one of four and the tool accepted anything. Every consumer then compared against those
  // four literals with no fallback: the TUI sidebar shows itself while any todo is not
  // "completed", the desktop dock counts "completed" exactly and picks the active row by
  // "in_progress" then "pending", and the tool title counts anything not "completed" as
  // outstanding. A single `status: "done"` therefore pinned the progress indicator below its total
  // and the sidebar open, forever, with a clean tool success and no error anywhere.
  test("the four documented states are accepted", () => {
    for (const status of ["pending", "in_progress", "completed", "cancelled"]) {
      const result = decode({ todos: todos(status) })
      expect(result.todos[0]?.status).toBe(status as SessionTodo.Info["status"])
    }
  })

  test("the three documented priorities are accepted", () => {
    for (const priority of ["high", "medium", "low"]) {
      const result = decode({ todos: todos("pending", priority) })
      expect(result.todos[0]?.priority).toBe(priority as SessionTodo.Info["priority"])
    }
  })

  test("a status outside the documented set is rejected rather than stored", () => {
    for (const status of ["done", "waiting", "Complete", "in progress", ""]) {
      expect(() => decode({ todos: todos(status) })).toThrow()
    }
  })

  test("a priority outside the documented set is rejected rather than stored", () => {
    for (const priority of ["urgent", "critical", "Medium", ""]) {
      expect(() => decode({ todos: todos("pending", priority) })).toThrow()
    }
  })

  test("the tool parameter schema and the response schema are one contract", () => {
    // The todowrite tool's parameters and `GET /session/:id/todo`'s response are both built from
    // `SessionTodo.Info`. They were separate definitions once and drifted; the tool accepted what
    // the response could not describe.
    const response = Schema.decodeUnknownSync(SessionTodo.Info)
    const tool = decode({ todos: todos("in_progress") }).todos[0]
    expect(response(tool)).toEqual(tool)
    expect(() => response({ content: "ship it", status: "done", priority: "medium" })).toThrow()
  })
})
