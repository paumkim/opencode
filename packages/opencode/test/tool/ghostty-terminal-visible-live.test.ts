/**
 * End-to-end check that the TOOL, not just the backend, actually opens a window.
 *
 * The mocked tests in ghostty-terminal.test.ts replace the visible module wholesale, so they
 * cannot catch a wrong session name, a bad dispatch, or an env that never reaches the window.
 * This drives the real thing: a real `ghostty` process on the user's display.
 *
 * Opt-in only, because it opens real windows:
 *   OPENCODE_VISIBLE_TEST=1 bun test test/tool/ghostty-terminal-visible-live.test.ts
 */
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { GhosttyTerminalTool } from "@/tool/ghostty-terminal"
import { Tool } from "@/tool/tool"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { TestConfig } from "../fixture/config"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Truncate.node,
      Config.node,
      Plugin.node,
      Session.node,
      SessionProjector.node,
      Permission.node,
      CrossSpawnSpawner.node,
    ]),
    [
      [Config.node, TestConfig.layer({ get: () => Effect.succeed({ shell: "/bin/sh" }) })],
      [
        Plugin.node,
        Layer.mock(Plugin.Service, { trigger: (_n, _i, output) => Effect.succeed(output) }),
      ],
    ],
  ),
)

const init = Effect.gen(function* () {
  const info = yield* GhosttyTerminalTool
  return yield* Tool.init(info)
})

const context = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "Visible live test" })
  const ctx: Tool.Context = {
    sessionID: session.id,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
  return ctx
})

// `bun test` runs every file under test/, so registering these unconditionally would
// open real windows on every suite run. Nothing is registered unless opted in.
if (process.env.OPENCODE_VISIBLE_TEST === "1") {
  it.instance(
    "display=visible opens a real window the user can see, and the agent reads the same screen",
    () =>
      Effect.gen(function* () {
        const tool = yield* init
        const ctx = yield* context
        const created = yield* tool.execute(
          { action: "create", name: "live", display: "visible", cols: 90, rows: 25 },
          ctx,
        )
        expect(created.metadata?.display).toBe("visible")
        expect(created.output).toContain("A real window is open")
        // A window is a compositor round-trip, so poll rather than assume a delay.
        const open = yield* pollWithTimeout(
          Effect.gen(function* () {
            const result = yield* tool.execute({ action: "screen", name: "live" }, ctx)
            return result.metadata?.windowOpen ? result : undefined
          }),
          "the window never appeared on screen",
        )
        expect(open.metadata?.display).toBe("visible")

        // The agent's screen must show what the user is looking at.
        yield* tool.execute(
          { action: "write", name: "live", data: "printf 'SHARED_VIEW\\n'\r" },
          ctx,
        )
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const result = yield* tool.execute({ action: "screen", name: "live", wait: 500 }, ctx)
            return result.output.includes("SHARED_VIEW") ? result : undefined
          }),
          "the agent could not read the shared screen",
        )

        const listed = yield* tool.execute({ action: "list" }, ctx)
        expect(listed.output).toContain('"display":"visible"')
        expect(listed.output).toContain("live")

        yield* tool.execute({ action: "dispose", name: "live" }, ctx)
        const after = yield* tool.execute({ action: "list" }, ctx)
        expect(after.output).not.toContain("SHARED_VIEW")
      }),
    120_000,
  )

  it.instance(
    "a headless terminal never claims the user can see it",
    () =>
      Effect.gen(function* () {
        const tool = yield* init
        const ctx = yield* context
        const created = yield* tool.execute(
          { action: "create", name: "hidden", cols: 60, rows: 20 },
          ctx,
        )
        expect(created.metadata?.display).toBeUndefined()
        expect(created.output).toContain("the user CANNOT see it")
        yield* tool.execute({ action: "dispose", name: "hidden" }, ctx)
      }),
    60_000,
  )
}
