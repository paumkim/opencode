import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { jsonSchema } from "ai"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Account } from "@/account/account"
import { Auth } from "@/auth"
import { GoalDriver } from "@/goal/driver"
import { createGoal } from "@/goal/impl"
import { Plugin } from "@/plugin"
import { LLMRequestPrep } from "@/session/llm/request"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { GOAL_SYSTEM_MARKER } from "@/goal/schema"

import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { Npm } from "@opencode-ai/core/npm"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, GoalDriver.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)

const model = {
  id: "anthropic/claude-sonnet-4-6",
  providerID: "anthropic",
  api: {
    id: "claude-sonnet-4-6",
    url: "https://api.anthropic.com",
    npm: "@ai-sdk/anthropic",
  },
  name: "Claude Sonnet 4.6",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: false, pdf: false, video: false },
    output: { text: true, audio: false, image: false, pdf: false, reasoning: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200000, output: 8192 },
  options: {},
  headers: {},
} as never as Parameters<typeof LLMRequestPrep.prepare>[0]["model"]

// Writes a project plugin whose system.transform hook records whether the goal reminder was
// already merged into `output.system` by the time an externally registered plugin runs.
const withObservingPlugin = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "observer.ts")
    yield* Effect.promise(() =>
      Bun.write(
        file,
        [
          "export default async () => ({",
          '  "experimental.chat.system.transform": (input, output) => {',
          '    globalThis.__goalProbe = output.system.some((block) => block.includes("OpenCode goal mode"))',
          "  },",
          "})",
          "",
        ].join("\n"),
      ),
    )
    yield* Effect.promise(() =>
      Bun.write(
        path.join(test.directory, "opencode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [pathToFileURL(file).href] }, null, 2),
      ),
    )
    return yield* self
  })

const prepareSystem = (sessionID: string) =>
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    return yield* LLMRequestPrep.prepare({
      user: {
        id: "msg_user-test",
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "test",
        model: { providerID: ProviderV2.ID.anthropic, modelID: ModelV2.ID.make("claude-sonnet-4-6") },
      } as never,
      sessionID,
      model,
      agent: { name: "test", mode: "primary", options: {}, permission: [] } as never,
      system: [],
      messages: [{ role: "user", content: "Hello" }],
      tools: {
        lookup: { description: "Look up a value", inputSchema: jsonSchema({ type: "object", properties: {} }) },
      },
      provider: { id: "anthropic", options: {} } as never,
      auth: undefined,
      plugin,
      flags: { outputTokenMax: 32_000, client: "test" } as never,
      isWorkflow: false,
    }).pipe(Effect.provideService(GoalDriver.Service, yield* GoalDriver.Service))
  })

describe("H11: goal hooks are dispatched from core, not the plugin bus", () => {
  it.instance("a core call site runs the goal hook even with every external plugin disabled", () =>
    Effect.gen(function* () {
      const sessionID = "ses_goal_dispatch_core"
      yield* Effect.promise(() => createGoal(sessionID, "ship the refactor"))
      const prepared = yield* prepareSystem(sessionID)
      expect(prepared.system.join("\n")).toContain(GOAL_SYSTEM_MARKER)
    }),
  )

  it.instance("the goal hook runs before any externally registered plugin hook", () =>
    withObservingPlugin(
      Effect.gen(function* () {
        const sessionID = "ses_goal_dispatch_order"
        yield* Effect.promise(() => createGoal(sessionID, "ship the refactor"))
        yield* prepareSystem(sessionID)
        // The observer plugin only records true if goal mode had already merged its reminder.
        expect((globalThis as Record<string, unknown>).__goalProbe).toBe(true)
        delete (globalThis as Record<string, unknown>).__goalProbe
      }),
    ),
  )

  it.instance("Plugin.trigger alone no longer dispatches goal hooks", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const sessionID = "ses_goal_dispatch_plugin_bus"
      yield* Effect.promise(() => createGoal(sessionID, "ship the refactor"))
      const output = { system: [] as string[] }
      yield* plugin.trigger(
        "experimental.chat.system.transform",
        {
          sessionID,
          model: { providerID: ProviderV2.ID.anthropic, modelID: ModelV2.ID.make("claude-sonnet-4-6") },
        },
        output,
      )
      expect(output.system.join("\n")).not.toContain(GOAL_SYSTEM_MARKER)
    }),
  )
})
