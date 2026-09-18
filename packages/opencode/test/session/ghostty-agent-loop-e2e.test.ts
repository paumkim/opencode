import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Permission } from "@/permission"
import { provideTmpdirServer } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  Permission.node,
  CrossSpawnSpawner.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])))

const info = Schema.Struct({
  name: Schema.String,
  pid: Schema.Number,
  exited: Schema.Boolean,
  exitCode: Schema.optional(Schema.Number),
})

it.live("ghostty-agent-loop-e2e: persistent PTY, screens and real SIGTERM exit roundtrip", () =>
  provideTmpdirServer(({ llm }) => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const permissions = yield* Permission.Service
    const permission = Permission.fromConfig({ ghostty_terminal: "allow", bash: "allow", doom_loop: "allow" })
    const session = yield* sessions.create({ title: "ghostty-agent-loop-e2e", permission })
    let turn = 0

    // Only the model HTTP transport is scripted. Every action enters the real
    // prompt loop, registry, permission service, processor and persisted history.
    const call = (args: Record<string, unknown>) => Effect.gen(function* () {
      const tag = `terminal-turn-${++turn}`
      const before = (yield* sessions.messages({ sessionID: session.id })).flatMap((m) => m.parts).length
      yield* llm.tool("ghostty_terminal", args)
      yield* llm.text(tag)
      const result = yield* awaitWithTimeout(prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
        parts: [{ type: "text", text: tag }],
      }), `agent loop stalled on ${JSON.stringify(args)}`, "10 seconds")
      expect(result.info.sessionID).toBe(session.id)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
      expect(result.parts.some((p) => p.type === "text" && p.text === tag)).toBe(true)
      const messages = yield* sessions.messages({ sessionID: session.id })
      const parts = messages.flatMap((m) => m.parts)
      expect(parts.length).toBeGreaterThan(before)
      const tool = parts.filter((p) => p.type === "tool").at(-1)
      expect(tool?.tool).toBe("ghostty_terminal")
      expect(tool?.sessionID).toBe(session.id)
      expect(tool?.state.input).toEqual(args)
      expect(tool?.state.status).toBe("completed")
      if (!tool || tool.state.status !== "completed") throw new Error(JSON.stringify(tool))
      // The follow-up HTTP request must carry the real tool result back to the model.
      const inputs = yield* llm.inputs
      const returned = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({
        role: Schema.String,
        content: Schema.optional(Schema.Unknown),
        tool_call_id: Schema.optional(Schema.String),
      })))(inputs.at(-1)?.messages).filter((m) => m.role === "tool").at(-1)
      expect(returned?.tool_call_id).toBe(tool.callID)
      expect(returned?.content).toBe(tool.state.output)
      expect(yield* llm.pending).toBe(0)
      expect(yield* permissions.list()).toEqual([])
      return tool.state.output
    })

    const created = Schema.decodeUnknownSync(info)(JSON.parse((yield* call({ action: "create", name: "proof" })).split("\n")[0]))
    expect(created).toMatchObject({ name: "proof", exited: false })
    expect(created.pid).toBeGreaterThan(0)
    // No subprocesses: sh builtins install the trap, then block in read. Split
    // markers and clear the viewport so echoed input cannot satisfy the checks.
    yield* call({ action: "write", name: "proof", data: "stty -echo; trap 'printf \"\\nTRAP_%s\\n\" DELIVERED; exit 42' TERM; printf '\\033[2J\\033[H\\033[31mKNOWN_%s\\033[0m\\nREADY_%s\\n' STRING MARKER; while :; do read -r line; done\r" })
    const screen = yield* pollWithTimeout(call({ action: "screen", name: "proof", format: "plain" }).pipe(
      Effect.map((text) => text.split(/\r?\n/).map((line) => line.trim()).includes("READY_MARKER") ? text : undefined),
    ), "ready marker never reached Ghostty screen", "10 seconds")
    expect(screen.split(/\r?\n/).map((line) => line.trim())).toContain("KNOWN_STRING")
    const html = yield* call({ action: "screen", name: "proof", format: "html" })
    expect(html).toContain("KNOWN_STRING")
    expect(html).toMatch(/style=["'][^"']*color:/)
    const live = Schema.decodeUnknownSync(Schema.Array(info))(JSON.parse(yield* call({ action: "list" })))
    expect(live).toEqual([created])
    yield* call({ action: "kill", name: "proof", signal: "SIGTERM" })
    yield* pollWithTimeout(call({ action: "screen", name: "proof", format: "plain" }).pipe(
      Effect.map((text) => text.split(/\r?\n/).map((line) => line.trim()).includes("TRAP_DELIVERED") ? true : undefined),
    ), "SIGTERM trap output never reached screen", "10 seconds")
    const exited = yield* pollWithTimeout(call({ action: "list" }).pipe(Effect.map((text) => {
      const item = Schema.decodeUnknownSync(Schema.Array(info))(JSON.parse(text))[0]
      return item?.exited ? item : undefined
    })), "PTY exit event was not delivered", "10 seconds")
    expect(exited).toEqual({ ...created, exited: true, exitCode: 42 })
    yield* call({ action: "dispose", name: "proof" })
    expect(yield* call({ action: "list" })).toBe("[]")
    yield* pollWithTimeout(Effect.sync(() => {
      try { process.kill(created.pid, 0) } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return true
        throw error
      }
    }), "owned shell process survived disposal")
    expect((yield* sessions.get(session.id)).permission).toEqual(permission)
  }), {
    config: (url) => ({
      model: "test/test-model",
      small_model: "test/test-model",
      enabled_providers: ["test"],
      shell: "/bin/sh",
      plugin: [],
      mcp: {},
      lsp: false,
      permission: { ghostty_terminal: "allow", bash: "allow", doom_loop: "allow" },
      provider: { test: {
        name: "Local scripted transport",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: url },
        models: { "test-model": {
          name: "Test Model", tool_call: true,
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
        } },
      } },
    }),
  }), 60000)
