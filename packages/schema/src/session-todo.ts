export * as SessionTodo from "./session-todo"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"

/**
 * The status and priority sets are closed, and they are closed HERE rather than only in the field
 * descriptions. Both were `Schema.String` wearing a description that named four statuses and three
 * priorities, so the tool accepted anything: a model that wrote `status: "done"` got a clean
 * success. Every consumer compares against these exact literals, and none of them has a fallback:
 * the TUI sidebar shows itself while any todo is not `completed`, the desktop dock counts `done` as
 * exactly `completed` and picks the active row by `in_progress` then `pending`, and the tool title
 * counts anything that is not `completed` as outstanding. One out-of-set value therefore pinned the
 * progress indicator below its total and the sidebar open, permanently and silently.
 *
 * This schema is also the tool's parameter schema and the `GET /session/:id/todo` response schema,
 * so a literal here both rejects the bad value at the write boundary and pins the read contract.
 * `Todo.get` drops rows that predate this, so an already-stored bad value cannot fail the response
 * encode and take the endpoint with it.
 */
export const Status = Schema.Literals(["pending", "in_progress", "completed", "cancelled"])
export const Priority = Schema.Literals(["high", "medium", "low"])

const STATUSES: ReadonlySet<string> = new Set(Status.literals)
const PRIORITIES: ReadonlySet<string> = new Set(Priority.literals)

/**
 * Whether a stored row's status and priority are both inside the contract.
 *
 * Two services read this table and both serve it as `Info` - the Location-scoped one in `core` and
 * the instance-scoped one in `opencode` - so the read-side repair has to be ONE predicate they both
 * call. A guard written beside only one of two readers is a guard the other will eventually fail to
 * apply, which is how a row written before the literals were enforced turns into a failed response
 * encode on one surface and a silently wrong list on the other.
 */
export function isInfo(value: { readonly status: unknown; readonly priority: unknown }) {
  return (
    typeof value.status === "string" &&
    STATUSES.has(value.status) &&
    typeof value.priority === "string" &&
    PRIORITIES.has(value.priority)
  )
}

export const Info = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Status.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Priority.annotate({
    description: "Priority level of the task: high, medium, low",
  }),
}).annotate({ identifier: "Todo" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const Updated = define({
  type: "todo.updated",
  schema: {
    sessionID: SessionID,
    todos: Schema.Array(Info),
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
