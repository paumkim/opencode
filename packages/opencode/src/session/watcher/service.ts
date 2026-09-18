import { Effect, Layer, Context } from "effect"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { NotFoundError } from "@/storage/storage"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { checkSession, type WatchResult } from "./watcher"

export interface Interface {
  readonly check: (sessionID: SessionID, lastDelta?: number) => Effect.Effect<WatchResult, NotFoundError>
  readonly checkActive: () => Effect.Effect<readonly WatchResult[]>
  readonly count: () => Effect.Effect<number>
  readonly report: () => Effect.Effect<WatchReport>
}

export interface WatchReport {
  readonly total: number
  readonly running: number
  readonly stalled: number
  readonly unknown: number
  readonly sessions: readonly WatchResult[]
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Watcher") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const status = yield* SessionStatus.Service
    const config = yield* Config.Service

    const check = Effect.fn("Watcher.check")(function* (sessionID: SessionID, lastDelta?: number) {
      const info = yield* session.get(sessionID)
      const messages = yield* session.messages({ sessionID, limit: 1 })
      const latest = messages.at(-1)
      return checkSession(
        {
          sessionID,
          title: info.title,
          lastUpdate: info.time.updated,
          lastDelta: lastDelta ?? Math.max(info.time.updated, latest?.info.time.created ?? 0),
          tokens: info.tokens,
          summary: info.summary && {
            additions: info.summary.additions,
            deletions: info.summary.deletions,
            files: info.summary.files,
          },
          latestMessage: latest && {
            role: latest.info.role,
            text: latest.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(" ")
              .trim(),
          },
          status: "running",
        },
        (yield* config.get()).experimental?.stall_threshold ?? 30,
      )
    })

    const checkActive = Effect.fn("Watcher.checkActive")(function* () {
      const active = yield* status.list()
      const results = yield* Effect.all(
        Array.from(active.keys(), (id) =>
          check(id).pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(null))),
        ),
      )
      return results.filter((result) => result !== null)
    })

    return Service.of({
      check,
      checkActive,
      count: Effect.fn("Watcher.count")(function* () {
        return (yield* status.list()).size
      }),
      report: Effect.fn("Watcher.report")(function* () {
        const sessions = yield* checkActive()
        return {
          total: sessions.length,
          running: sessions.filter((result) => result.status === "RUNNING").length,
          stalled: sessions.filter((result) => result.status === "STALLED").length,
          unknown: sessions.filter((result) => result.status === "UNKNOWN").length,
          sessions,
        }
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, SessionStatus.node, Config.node],
})

export * as Watcher from "./service"
