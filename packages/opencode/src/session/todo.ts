import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { TodoTable } from "@opencode-ai/core/session/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionTodo } from "@opencode-ai/schema/session-todo"

export const Info = SessionTodo.Info
export type Info = SessionTodo.Info

export const Event = SessionTodo.Event

export interface Interface {
  readonly update: (input: { sessionID: SessionID; todos: ReadonlyArray<Info> }) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTodo") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const update = Effect.fn("Todo.update")(function* (input: { sessionID: SessionID; todos: ReadonlyArray<Info> }) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
            if (input.todos.length === 0) return
            yield* tx
              .insert(TodoTable)
              .values(
                input.todos.map((todo, position) => ({
                  session_id: input.sessionID,
                  content: todo.content,
                  status: todo.status,
                  priority: todo.priority,
                  position,
                })),
              )
              .run()
          }),
        )
        .pipe(Effect.orDie)
      yield* events.publish(Event.Updated, input)
    })

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID) {
      const rows = yield* db
        .select()
        .from(TodoTable)
        .where(eq(TodoTable.session_id, sessionID))
        .orderBy(asc(TodoTable.position))
        .all()
        .pipe(Effect.orDie)
      return rows
        .filter((row) => {
          // `Info` is a closed set and it is the `GET /session/:id/todo` response schema, so a row
          // written before the set was enforced would fail the response encode and take the endpoint
          // with it. The list is model-managed transient state that the next todowrite rewrites
          // whole, so dropping the unusable row is the repair - but it must not be silent, because a
          // silently short list is indistinguishable from the model having removed the item.
          if (SessionTodo.isInfo(row)) return true
          console.warn(
            `[todo] session ${sessionID} has a todo with status=${JSON.stringify(row.status)} ` +
              `priority=${JSON.stringify(row.priority)}, which is not in the todo contract; dropping it`,
          )
          return false
        })
        .map((row) => ({
          content: row.content,
          status: row.status as Info["status"],
          priority: row.priority as Info["priority"],
        }))
    })

    return Service.of({ update, get })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, Database.node] })

export * as Todo from "./todo"
