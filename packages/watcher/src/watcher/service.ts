// Watcher Service — Effect layer for session stall detection.
// Reads full session info + latest messages to build accurate summaries,
// then classifies each active session as RUNNING / STALLED / UNKNOWN.

import { Effect, Layer, Context } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { check, type WatchResult, type SessionInfo } from "./watcher"

export interface Interface {
  /** Check a single session by ID — reads full info + latest messages. */
  readonly check: (sessionID: SessionID) => Effect.Effect<WatchResult, NotFoundError>

  /** Check all active (non-idle) sessions. */
  readonly checkActive: () => Effect.Effect<readonly WatchResult[]>

  /** Count active (non-idle) sessions. */
  readonly count: () => Effect.Effect<number>

  /** Full status report: counts + per-session classification. */
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

export const use = Effect.serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const status = yield* SessionStatus.Service

    /**
     * Build a human-readable summary from full session info + latest messages.
     * This is what the classifier reads to determine stall status.
     */
    const buildSummary = Effect.fn("Watcher.buildSummary")(function* (
      info: Session.Info,
    ) {
      const parts: string[] = []

      // Title
      if (info.title && info.title !== "New session") {
        parts.push(`Session: ${info.title}`)
      }

      // Time since last update
      const now = Date.now()
      const secondsAgo = Math.floor((now - info.time.updated) / 1000)
      const minutesAgo = Math.floor(secondsAgo / 60)

      if (secondsAgo < 5) {
        parts.push("actively generating")
      } else if (secondsAgo < 30) {
        parts.push(`last activity ${secondsAgo} seconds ago`)
      } else if (minutesAgo < 2) {
        parts.push(`last activity ${secondsAgo} seconds ago`)
      } else if (minutesAgo < 15) {
        parts.push(`last activity ${minutesAgo} minutes ago`)
      } else {
        parts.push(`last activity ${minutesAgo} minutes ago, possibly stalled`)
      }

      // Token counts
      if (info.tokens) {
        if (info.tokens.output > 0) {
          parts.push(`${info.tokens.output} tokens generated`)
        }
        if (info.tokens.input > 0) {
          parts.push(`${info.tokens.input} input tokens`)
        }
      }

      // Code change summary
      if (info.summary) {
        const s = info.summary
        const changes: string[] = []
        if (s.additions > 0) changes.push(`+${s.additions} lines`)
        if (s.deletions > 0) changes.push(`-${s.deletions} lines`)
        if (s.files > 0) changes.push(`${s.files} files`)
        if (changes.length > 0) {
          parts.push(`code changes: ${changes.join(", ")}`)
        }
      }

      // Latest message content (truncated)
      const messages = yield* session.messages({ sessionID: info.id, limit: 1 })
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1]
        if (lastMsg) {
          const role = lastMsg.role
          const textParts = lastMsg.parts?.filter(
            (p): p is { type: "text"; text: string } => p.type === "text",
          ) ?? []
          const text = textParts.map((p) => p.text).join(" ").trim().slice(0, 200)
          if (text) {
            parts.push(`latest ${role}: ${text}`)
          }
        }
      }

      return parts.join(". ")
    })

    /** Build a WatchResult from a Session.Info */
    const toResult = Effect.fn("Watcher.toResult")(function* (
      info: Session.Info,
    ) {
      const summary = yield* buildSummary(info)
      const now = Date.now()

      // Hard rule: no content at all = stalled
      const hasContent =
        (info.tokens && (info.tokens.output > 0 || info.tokens.input > 0)) ||
        (info.summary && (info.summary.additions > 0 || info.summary.deletions > 0 || info.summary.files > 0))

      let status: WatchResult["status"]
      if (!hasContent) {
        status = "STALLED"
      } else {
        status = check(summary)
      }

      return {
        sessionID: info.id,
        title: info.title,
        status,
        summary,
        secondsSinceUpdate: Math.floor((now - info.time.updated) / 1000),
      } satisfies WatchResult
    })

    return {
      check: Effect.fn("Watcher.check")(function* (sessionID) {
        const info = yield* session.get(sessionID)
        return yield* toResult(info)
      }),

      checkActive: Effect.fn("Watcher.checkActive")(function* () {
        const active = yield* status.list()
        const results: WatchResult[] = []

        for (const [sessionID, _status] of active) {
          const result = yield* Effect.gen(function* () {
            const info = yield* session.get(sessionID).pipe(
              Effect.catchAll(() => Effect.succeed(null)),
            )
            if (!info) return null
            return yield* toResult(info)
          })
          if (result) results.push(result)
        }

        return results
      }),

      count: Effect.fn("Watcher.count")(function* () {
        const active = yield* status.list()
        return active.size
      }),

      report: Effect.fn("Watcher.report")(function* () {
        const results = yield* Effect.gen(function* () {
          const active = yield* status.list()
          const items: WatchResult[] = []

          for (const [sessionID, _status] of active) {
            const result = yield* Effect.gen(function* () {
              const info = yield* session.get(sessionID).pipe(
                Effect.catchAll(() => Effect.succeed(null)),
              )
              if (!info) return null
              return yield* toResult(info)
            })
            if (result) items.push(result)
          }

          return items
        })

        let running = 0
        let stalled = 0
        let unknown = 0
        for (const r of results) {
          if (r.status === "RUNNING") running++
          else if (r.status === "STALLED") stalled++
          else unknown++
        }

        return {
          total: results.length,
          running,
          stalled,
          unknown,
          sessions: results,
        } satisfies WatchReport
      }),
    }
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, SessionStatus.node],
})

export * as Watcher from "./watcher"