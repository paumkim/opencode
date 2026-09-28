import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "path"
import { Effect, FileSystem, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

import { Instruction } from "../../src/session/instruction"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Global } from "@opencode-ai/core/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { errorMessage } from "@/util/error"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform, httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Config } from "@/config/config"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node, httpClient]),
    [
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const configLayer = Layer.succeed(Config.Service, TestConfig.make())

const instructionLayer = (
  global: Partial<Global.Interface>,
  flags: Partial<RuntimeFlags.Info> = {},
  client?: HttpClient.HttpClient,
) =>
  AppNodeBuilder.build(Instruction.node, [
    [Config.node, configLayer],
    ...(client ? ([[httpClient, Layer.succeed(HttpClient.HttpClient, client)]] as const) : []),
    [Global.node, Global.layerWith(global)],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const provideInstruction =
  (global: Partial<Global.Interface>, flags?: Partial<RuntimeFlags.Info>, client?: HttpClient.HttpClient) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags, client)))

// A response whose body arrives as a stream, so the cap in `fetch` is exercised on real chunks
// rather than a single pre-sized `Response` body.
const streaming = (request: HttpClientRequest.HttpClientRequest, chunks: readonly Uint8Array[]) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      }),
    ),
  )

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const writeFiles = (dir: string, files: Record<string, string>) =>
  Effect.all(
    Object.entries(files).map(([file, content]) => write(path.join(dir, file), content)),
    { discard: true },
  )

const withFiles = <A, E, R>(files: Record<string, string>, self: (dir: string) => Effect.Effect<A, E, R>) =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      yield* writeFiles(dir, files)
      return yield* self(dir).pipe(provideInstruction({ home: dir, config: dir }))
    }),
  )

const tmpWithFiles = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* writeFiles(dir, files)
    return dir
  })

function loaded(filepath: string): SessionV1.WithParts[] {
  const sessionID = SessionID.make("session-loaded-1")
  const messageID = MessageID.make("msg_message-loaded-1")

  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: "build",
        model: {
          providerID: ProviderV2.ID.make("anthropic"),
          modelID: ModelV2.ID.make("claude-sonnet-4-20250514"),
        },
      },
      parts: [
        {
          id: PartID.make("prt_part-loaded-1"),
          messageID,
          sessionID,
          type: "tool",
          callID: "call-loaded-1",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: "Read",
            metadata: { loaded: [filepath] },
            time: { start: 0, end: 1 },
          },
        },
      ],
    },
  ]
}

describe("Instruction.resolve", () => {
  it.live("returns empty when AGENTS.md is at project root (already in systemPaths)", () =>
    withFiles({ "AGENTS.md": "# Root Instructions", "src/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "AGENTS.md"))).toBe(true)

        const results = yield* svc.resolve([], path.join(dir, "src", "file.ts"), MessageID.make("msg_message-test-1"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("returns AGENTS.md from subdirectory (not in systemPaths)", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "subdir", "AGENTS.md"))).toBe(false)

        const results = yield* svc.resolve(
          [],
          path.join(dir, "subdir", "nested", "file.ts"),
          MessageID.make("msg_message-test-2"),
        )
        expect(results.length).toBe(1)
        expect(results[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("doesn't reload AGENTS.md when reading it directly", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "AGENTS.md")
        const system = yield* svc.systemPaths()
        expect(system.has(filepath)).toBe(false)

        const results = yield* svc.resolve([], filepath, MessageID.make("msg_message-test-3"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("does not reattach the same nearby instructions twice for one message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-1")

        const first = yield* svc.resolve([], filepath, id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(first[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
        expect(second).toEqual([])
      }),
    ),
  )

  it.live("clear allows nearby instructions to be attached again for the same message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-2")

        const first = yield* svc.resolve([], filepath, id)
        yield* svc.clear(id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(second).toHaveLength(1)
        expect(second[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("skips instructions already reported by prior read metadata", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const agents = path.join(dir, "subdir", "AGENTS.md")
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-3")

        const results = yield* svc.resolve(loaded(agents), filepath, id)
        expect(results).toEqual([])
      }),
    ),
  )

  // The gap this block used to describe is now closed: the HttpClient node is in the harness and
  // the remote branch is asserted below, including the cap that bounds what a config-named URL can
  // contribute to the system prompt.
  const remoteSystem = (instructions: string[], client: HttpClient.HttpClient) =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        return yield* (yield* Instruction.Service).system()
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(Instruction.node, [
            [Config.node, TestConfig.layer({ get: () => Effect.succeed({ instructions }) })],
            [Global.node, Global.layerWith({ home: dir, config: dir })],
            [RuntimeFlags.node, RuntimeFlags.layer({})],
            [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
          ]),
        ),
      ),
    )

  const text = (value: string) => new TextEncoder().encode(value)

  it.live("attributes a fetched instruction to its URL", () =>
    Effect.gen(function* () {
      const url = "https://example.test/instructions.md"
      const client = HttpClient.make((request) => Effect.succeed(streaming(request, [text("# Remote")])))
      expect(yield* remoteSystem([url], client)).toEqual([`Instructions from: ${url}\n# Remote`])
    }),
  )

  it.live("drops only the entry whose fetch fails", () =>
    Effect.gen(function* () {
      const good = "https://example.test/good.md"
      const bad = "https://example.test/bad.md"
      // A 500, not a defect: `Effect.die` is a defect and `Effect.catch` in `fetch` only sees
      // typed failures, so a defect would take the whole call down instead of dropping one entry.
      const client = HttpClient.make((request) =>
        Effect.succeed(
          request.url.includes("bad")
            ? HttpClientResponse.fromWeb(request, new Response("nope", { status: 500 }))
            : streaming(request, [text("# ok")]),
        ),
      )
      // A failing entry contributes nothing and takes nothing else with it: `systemPaths` still
      // runs, and the surviving URL is still attributed.
      expect(yield* remoteSystem([good, bad], client)).toEqual([`Instructions from: ${good}\n# ok`])
    }),
  )

  it.live("stops reading a remote body at the cap and says so", () =>
    Effect.gen(function* () {
      const url = "https://example.test/huge.md"
      // 40 x 16KiB is well past the 256KiB cap, delivered as a pull-driven stream so the test
      // fails against an implementation that drains the whole body and truncates afterwards.
      const chunks = Array.from({ length: 40 }, () => new Uint8Array(16 * 1024).fill(97))
      let pulled = 0
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream({
                pull(controller) {
                  const chunk = chunks[pulled++]
                  if (!chunk) return controller.close()
                  controller.enqueue(chunk)
                },
              }),
            ),
          ),
        ),
      )
      const [rule] = yield* remoteSystem([url], client)
      // Assert the read stopped BEFORE the text: an implementation that drains the body and
      // truncates afterwards would still satisfy every assertion below, and the unbounded read is
      // the part that costs memory.
      expect(pulled).toBeLessThan(40)
      expect(rule).toStartWith(`Instructions from: ${url}\n`)
      expect(rule).toEndWith("[opencode: instruction truncated]")
      // 256KiB of "a" plus the header, not the full 640KiB body.
      expect(rule.length).toBeLessThan(300 * 1024)
    }),
  )

  it.live("truncates a local instruction file on a character boundary", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // A 3-byte character placed so it straddles the cap: a byte cut there would decode to
        // U+FFFD, which is the whole reason `decodeInstruction` steps back instead of slicing.
        const filler = "a".repeat(256 * 1024 - 1)
        yield* write(path.join(dir, "big.md"), filler + "\u20ac tail")
        const [rule] = yield* (yield* Instruction.Service).system()
        expect(rule).toEndWith("[opencode: instruction truncated]")
        expect(rule).not.toContain("\uFFFD")
        expect(rule).toContain(filler)
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(Instruction.node, [
            [Config.node, TestConfig.layer({ get: () => Effect.succeed({ instructions: ["big.md"] }) })],
            [Global.node, Global.layerWith({ home: dir, config: dir })],
            [RuntimeFlags.node, RuntimeFlags.layer({})],
          ]),
        ),
      ),
    ),
  )
})

describe("Instruction.system", () => {
  it.live("loads both project and global AGENTS.md when both exist", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": "# Project Instructions" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(projectTmp, "AGENTS.md"))).toBe(true)
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)

        const rules = yield* svc.system()
        expect(rules).toHaveLength(2)
        expect(rules[0]).toBe(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}\n# Global Instructions`)
        expect(rules[1]).toBe(`Instructions from: ${path.join(projectTmp, "AGENTS.md")}\n# Project Instructions`)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("skips project and global CLAUDE.md when Claude Code prompt is disabled", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ ".claude/CLAUDE.md": "# Global Claude" })
      const projectTmp = yield* tmpWithFiles({ "CLAUDE.md": "# Project Claude" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, ".claude", "CLAUDE.md"))).toBe(false)
        expect(paths.has(path.join(projectTmp, "CLAUDE.md"))).toBe(false)
        expect(yield* svc.system()).toEqual([])
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, { disableClaudeCodePrompt: true }),
      )
    }),
  )
})

describe("Instruction.systemPaths global config", () => {
  it.live("uses Global.Service config AGENTS.md", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )
})

// `read` used to catch every failure into `""` and then cache that empty string, so a single
// permissions error or transient IO fault deleted the project's instructions from the agent's
// context for the rest of the instance. Nothing distinguishes "no such file" from "could not read
// it", so the model proceeds as though the project has no rules. The failure has to stay uncached
// (so the next turn retries) and has to be reported (so the reason is not dropped).
describe("Instruction.readInstructionFile", () => {
  const state = () => ({ cache: new Map<string, string>() })
  const report = () => {
    const seen: { filepath: string; error: unknown }[] = []
    return {
      seen,
      onFailure: (filepath: string, error: unknown) => Effect.sync(() => void seen.push({ filepath, error })),
    }
  }

  test("caches a successful read and serves it back", async () => {
    const s = state()
    const { seen, onFailure } = report()
    const first = await Effect.runPromise(
      Instruction.readInstructionFile(s, "AGENTS.md", Effect.succeed("rules"), onFailure),
    )
    const second = await Effect.runPromise(
      Instruction.readInstructionFile(s, "AGENTS.md", Effect.die("never re-read"), onFailure),
    )

    expect(first).toBe("rules")
    expect(second).toBe("rules")
    expect(s.cache.get("AGENTS.md")).toBe("rules")
    expect(seen).toEqual([])
  })

  test("caches a genuinely empty file, because there the empty result is the truth", async () => {
    const s = state()
    const { onFailure } = report()
    await Effect.runPromise(Instruction.readInstructionFile(s, "EMPTY.md", Effect.succeed(""), onFailure))
    expect(s.cache.get("EMPTY.md")).toBe("")
    expect(s.cache.has("EMPTY.md")).toBe(true)
  })

  test("does not cache a failed read, so a later turn retries and recovers", async () => {
    const s = state()
    const { seen, onFailure } = report()
    const failing = Effect.fail(new Error("EACCES: permission denied"))

    expect(await Effect.runPromise(Instruction.readInstructionFile(s, "AGENTS.md", failing, onFailure))).toBe("")
    expect(s.cache.has("AGENTS.md")).toBe(false)

    // The retry is what makes this recoverable: a transient fault no longer poisons the session.
    const recovered = await Effect.runPromise(
      Instruction.readInstructionFile(s, "AGENTS.md", Effect.succeed("rules"), onFailure),
    )
    expect(recovered).toBe("rules")
    expect(s.cache.get("AGENTS.md")).toBe("rules")
  })

  test("reports the reason a read failed instead of dropping it", async () => {
    const s = state()
    const { seen, onFailure } = report()
    await Effect.runPromise(
      Instruction.readInstructionFile(s, "AGENTS.md", Effect.fail(new Error("EACCES")), onFailure),
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.filepath).toBe("AGENTS.md")
    expect((seen[0]?.error as Error).message).toBe("EACCES")
  })

  test("reports a non-Error failure reason rather than rendering it as {}", async () => {
    const s = state()
    const { seen, onFailure } = report()
    await Effect.runPromise(
      Instruction.readInstructionFile(s, "AGENTS.md", Effect.fail({ code: "ETIMEDOUT" }), onFailure),
    )
    expect(seen).toHaveLength(1)
    // The trap this guards: a plain object reason must not be stringified into a useless "{}".
    expect(errorMessage(seen[0]?.error)).not.toBe("{}")
  })
})
