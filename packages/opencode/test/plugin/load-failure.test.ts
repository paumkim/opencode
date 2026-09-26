// A plugin can resolve, install, and load successfully and still throw the moment it is applied.
// Every other stage that can fail a plugin reports the failure to the user; this one used to stop
// at the log, so a broken plugin looked like it had merely been skipped.
import { describe, expect } from "bun:test"
import { Effect, Ref } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import path from "path"
import { pathToFileURL } from "url"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, EventV2Bridge.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)

const boom = [
  "export default {",
  '  id: "boom",',
  "  server: async () => {",
  '    throw new Error("plugin exploded during apply")',
  "  },",
  "}",
  "",
].join("\n")

function project(body: string) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "plugin.ts")
    yield* Effect.promise(() => Bun.write(file, body))
    yield* Effect.promise(() =>
      Bun.write(
        path.join(test.directory, "opencode.json"),
        JSON.stringify(
          { $schema: "https://opencode.ai/config.json", plugin: [pathToFileURL(file).href] },
          null,
          2,
        ),
      ),
    )
  })
}

describe("plugin load failure reporting", () => {
  it.instance(
    "tells the user a plugin threw while being applied",
    Effect.gen(function* () {
      yield* project(boom)

      const events = yield* EventV2Bridge.Service
      const reported = yield* Ref.make<string[]>([])
      const unsub = yield* events.listen((evt) => {
        if (evt.type !== Session.Event.Error.type) return Effect.void
        const message = (evt.data as { error?: { data?: { message?: string } } }).error?.data?.message
        if (!message?.includes("Failed to load plugin")) return Effect.void
        return Ref.update(reported, (list) => [...list, message])
      })
      yield* Effect.addFinalizer(() => unsub)

      const plugin = yield* Plugin.Service
      yield* plugin.init()

      const first = yield* pollWithTimeout(
        Ref.get(reported).pipe(Effect.map((list) => list[0])),
        "no plugin load error was reported to the user",
        "5 seconds",
      )
      expect(first).toContain("plugin.ts")
      expect(first).toContain("plugin exploded during apply")
    }),
  )

  it.instance(
    "contributes no hooks and does not take the loader down",
    Effect.gen(function* () {
      yield* project(boom)
      const plugin = yield* Plugin.Service
      // A plugin that throws must not register partial hooks, and must not abort loading.
      yield* plugin.init()
      expect(yield* plugin.list()).toEqual([])
    }),
  )
})
