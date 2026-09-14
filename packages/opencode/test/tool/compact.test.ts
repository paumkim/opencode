import { afterEach, describe, expect } from "bun:test"
import { Exit, Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { CompactTool } from "../../src/tool/compact"
import { type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

afterEach(async () => {
  await disposeAllInstances()
})

// `Session.Info.model` uses `id` (ModelV2.ID), not `modelID`.
const ref = {
  providerID: ProviderV2.ID.make("test"),
  id: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())

const seed = Effect.fn("CompactToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title, agent: "build", model: ref })
  return { chat }
})

function stubOps(opts?: {
  onCompact?: (input: Parameters<TaskPromptOps["compact"]>[0]) => void
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template: string) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: () =>
      Effect.succeed<SessionV1.WithParts>({
        info: {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: MessageID.ascending(),
          sessionID: SessionID.make("ses_test"),
          mode: "general",
          agent: "general",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.id,
          providerID: ref.providerID,
          time: { created: Date.now() },
          finish: "stop",
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: MessageID.ascending(),
            sessionID: SessionID.make("ses_test"),
            type: "text",
            text: "done",
          },
        ],
      }),
    compact: (input) => Effect.sync(() => opts?.onCompact?.(input)),
  }
}

function ctxFor(chat: { id: string }, messageID: MessageID, promptOps: TaskPromptOps) {
  return {
    sessionID: SessionID.make(chat.id),
    messageID,
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps },
    messages: [],
    metadata: (_input: { title?: string; metadata?: {} }) => Effect.void,
    ask: () => Effect.void,
  }
}

describe("tool.compact", () => {
  it.instance("enqueues a compaction marker on the current session", () =>
    Effect.gen(function* () {
      const { chat } = yield* seed()
      const tool = yield* CompactTool
      const def = yield* tool.init()
      let compacted: Parameters<TaskPromptOps["compact"]>[0] | undefined
      const promptOps = stubOps({ onCompact: (input) => (compacted = input) })
      const result = yield* def.execute({}, ctxFor(chat, MessageID.ascending(), promptOps))
      expect(result.title).toBe("Compacted session")
      expect(compacted).toBeDefined()
      expect(compacted!.sessionID).toBe(SessionID.make(chat.id))
      expect(compacted!.agent).toBe("build")
      // The compaction agent inherits the parent's model: whatever model the
      // calling agent is using to talk to the parent is the model compaction
      // runs on.
      expect(compacted!.model).toEqual({ providerID: ref.providerID, modelID: ref.id })
    }),
  )

  it.instance("inherits the parent's model when the session has one", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const chat = yield* session.create({
        title: "Inherit",
        agent: "build",
        model: { providerID: ProviderV2.ID.make("openai"), id: ModelV2.ID.make("gpt-4o") },
      })
      const tool = yield* CompactTool
      const def = yield* tool.init()
      let compacted: Parameters<TaskPromptOps["compact"]>[0] | undefined
      const promptOps = stubOps({ onCompact: (input) => (compacted = input) })
      yield* def.execute({}, ctxFor(chat, MessageID.ascending(), promptOps))
      expect(compacted!.model).toEqual({
        providerID: ProviderV2.ID.make("openai"),
        modelID: ModelV2.ID.make("gpt-4o"),
      })
    }),
  )

  it.instance("fails when promptOps is not injected", () =>
    Effect.gen(function* () {
      const { chat } = yield* seed()
      const tool = yield* CompactTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          {},
          ctxFor(chat, MessageID.ascending(), undefined as unknown as TaskPromptOps),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})