import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import fs from "fs/promises"

export interface CheckpointInfo {
  readonly id: string
  readonly sessionID: string
  readonly task: string
  readonly timestamp: number
  readonly accomplishments: string[]
  readonly nextSteps: string[]
  readonly context: Record<string, unknown>
}

export interface Interface {
  readonly create: (input: {
    sessionID: string
    task: string
    accomplishments?: string[]
    nextSteps?: string[]
    context?: Record<string, unknown>
  }) => Effect.Effect<CheckpointInfo | undefined>
  readonly get: (sessionID: string) => Effect.Effect<CheckpointInfo[]>
  readonly resume: (sessionID: string) => Effect.Effect<CheckpointInfo | undefined>
  readonly clear: (sessionID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Checkpoint") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service

    const checkpointDir = (sessionID: string) =>
      path.join(Global.Path.data, "checkpoints", sessionID)

    const create = Effect.fn("Checkpoint.create")(function* (input: {
      sessionID: string
      task: string
      accomplishments?: string[]
      nextSteps?: string[]
      context?: Record<string, unknown>
    }) {
      const cfg = yield* config.get()
      if (!cfg.experimental?.checkpoint?.enabled) return undefined
      const dir = checkpointDir(input.sessionID)
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true })).pipe(Effect.orDie)
      const id = Date.now().toString()
      const checkpoint: CheckpointInfo = {
        id,
        sessionID: input.sessionID,
        task: input.task,
        timestamp: Date.now(),
        accomplishments: input.accomplishments ?? [],
        nextSteps: input.nextSteps ?? [],
        context: input.context ?? {},
      }
      const filePath = path.join(dir, `${id}.json`)
      yield* Effect.promise(() => fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2))).pipe(Effect.orDie)
      return checkpoint
    })

    const get = Effect.fn("Checkpoint.get")(function* (sessionID: string) {
      const dir = checkpointDir(sessionID)
      const files = yield* Effect.tryPromise(() => fs.readdir(dir)).pipe(
        Effect.catch((error) => {
          const cause = (error as { cause?: unknown })?.cause ?? error
          return (cause as NodeJS.ErrnoException)?.code === "ENOENT"
            ? Effect.succeed([] as string[])
            : Effect.die(error)
        }),
      )
      const checkpoints = yield* Effect.forEach(
        files.filter((f: string) => f.endsWith(".json")),
        (file: string) =>
          Effect.tryPromise(() =>
            fs.readFile(path.join(dir, file), "utf-8").then((content) => JSON.parse(content) as CheckpointInfo),
          ).pipe(Effect.orDie),
        { concurrency: "unbounded" },
      )
      return checkpoints.sort((a, b) => b.timestamp - a.timestamp)
    })

    const resume = Effect.fn("Checkpoint.resume")(function* (sessionID: string) {
      const checkpoints = yield* get(sessionID)
      return checkpoints[0]
    })

    const clear = Effect.fn("Checkpoint.clear")(function* (sessionID: string) {
      const dir = checkpointDir(sessionID)
      yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore)
    })

    return Service.of({
      create,
      get: (sessionID: string) => get(sessionID).pipe(Effect.orDie),
      resume: (sessionID: string) => resume(sessionID).pipe(Effect.orDie),
      clear,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node],
})

export * as Checkpoint from "./checkpoint"
