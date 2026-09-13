import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import fs from "fs/promises"

export interface DecisionEntry {
  readonly timestamp: number
  readonly decision: string
  readonly rationale: string
  readonly context: string
}

export interface Interface {
  readonly log: (input: {
    decision: string
    rationale: string
    context: string
  }) => Effect.Effect<void>
  readonly get: () => Effect.Effect<DecisionEntry[]>
  readonly clear: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Decisions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service

    const decisionsFile = Effect.fn("Decisions.file")(function* () {
      const ctx = yield* InstanceState.context
      return path.join(Global.Path.data, "decisions", `${ctx.project.id}.md`)
    })

    const log = Effect.fn("Decisions.log")(function* (input: {
      decision: string
      rationale: string
      context: string
    }) {
      const cfg = yield* config.get()
      if (!cfg.experimental?.checkpoint?.enabled) return
      const file = yield* decisionsFile()
      yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true })).pipe(Effect.orDie)
      const entry: DecisionEntry = {
        timestamp: Date.now(),
        decision: input.decision,
        rationale: input.rationale,
        context: input.context,
      }
      const entryText = `## ${new Date(entry.timestamp).toISOString()}\n\n**Decision:** ${entry.decision}\n\n**Rationale:** ${entry.rationale}\n\n**Context:** ${entry.context}\n\n---\n\n`
      yield* Effect.promise(() => fs.appendFile(file, entryText)).pipe(Effect.orDie)
    })

    const get = Effect.fn("Decisions.get")(function* () {
      const file = yield* decisionsFile()
      let content: string
      try {
        content = yield* Effect.promise(() => fs.readFile(file, "utf-8")).pipe(Effect.orDie)
      } catch {
        return []
      }
      const entries = content
        .split("\n---\n")
        .filter((block) => block.trim())
        .map((block) => {
          const decisionMatch = block.match(/\*\*Decision:\*\* (.+)/)
          const rationaleMatch = block.match(/\*\*Rationale:\*\* (.+)/)
          const contextMatch = block.match(/\*\*Context:\*\* (.+)/)
          const timeMatch = block.match(/## (.+)/)
          return {
            timestamp: timeMatch ? new Date(timeMatch[1]!).getTime() : 0,
            decision: decisionMatch ? decisionMatch[1]! : "",
            rationale: rationaleMatch ? rationaleMatch[1]! : "",
            context: contextMatch ? contextMatch[1]! : "",
          }
        })
        .filter((e) => e.decision)
      return entries
    })

    const clear = Effect.fn("Decisions.clear")(function* () {
      const file = yield* decisionsFile()
      yield* Effect.promise(() => fs.rm(file, { force: true })).pipe(Effect.ignore)
    })

    return Service.of({ log, get, clear })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node],
})

export * as Decisions from "./decisions"
