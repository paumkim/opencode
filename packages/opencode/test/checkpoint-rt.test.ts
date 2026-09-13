import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../test/lib/effect"
import { Checkpoint } from "../src/checkpoint/checkpoint"
import { Config } from "../src/config/config"

const test = testEffect(LayerNode.compile(LayerNode.group([Checkpoint.node, Config.node])))

describe("Checkpoint round-trip", () => {
  test.instance(
    "create then resume returns the checkpoint",
    () =>
      Effect.gen(function* () {
        const checkpoint = yield* Checkpoint.Service
        const created = yield* checkpoint.create({
          sessionID: "ses_test",
          task: "do the thing",
          accomplishments: ["did x"],
          nextSteps: ["do y"],
          context: { foo: "bar" },
        })
        expect(created).toBeDefined()
        const resumed = yield* checkpoint.resume("ses_test")
        expect(resumed).toBeDefined()
        expect(resumed?.task).toBe("do the thing")
        expect(resumed?.accomplishments).toEqual(["did x"])
        expect(resumed?.nextSteps).toEqual(["do y"])
        expect(resumed?.context).toEqual({ foo: "bar" })
      }),
    { config: { experimental: { checkpoint: { enabled: true } } } },
  )

  test.instance("resume returns undefined when no checkpoint exists", () =>
    Effect.gen(function* () {
      const checkpoint = yield* Checkpoint.Service
      const resumed = yield* checkpoint.resume("ses_missing")
      expect(resumed).toBeUndefined()
    }),
  )
})