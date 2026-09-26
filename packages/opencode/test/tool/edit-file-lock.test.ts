import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EditTool, testFileLocks } from "../../src/tool/edit"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "@/format"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "@/session/schema"
import * as Tool from "@/tool/tool"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]),
)

const it = testEffect(layer)

const ctx = (overrides: Partial<Tool.Context> = {}): Tool.Context => ({
  sessionID: SessionID.make("ses_test-edit-file-lock"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  ...overrides,
})

const init = Effect.fn("EditFileLockTest.init")(function* () {
  const info = yield* EditTool
  return yield* info.init()
})

const run = Effect.fn("EditFileLockTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const put = Effect.fn("EditFileLockTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const load = Effect.fn("EditFileLockTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})

describe("tool.edit per-file lock", () => {
  it.instance("does not retain a lock entry per edited path", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const paths = Array.from({ length: 8 }, (_, i) => path.join(test.directory, `leak-${i}.txt`))

      for (const filepath of paths) {
        yield* run({ filePath: filepath, oldString: "", newString: "hello" }, ctx())
        // Each edit creates an entry; the entry must be gone before the next one.
        expect(testFileLocks.size).toBe(0)
      }

      for (const filepath of paths) expect(testFileLocks.has(filepath)).toBe(false)
      expect(testFileLocks.size).toBe(0)
    }),
  )

  it.instance("releases the lock entry when an edit fails", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "missing.txt")
      const exit = yield* run({ filePath: filepath, oldString: "nope", newString: "yes" }, ctx()).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(testFileLocks.size).toBe(0)
    }),
  )

  it.instance("serializes concurrent edits of the same file without lost updates", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "shared.txt")
      yield* put(filepath, "alpha\nbeta\n")

      // The permission prompt is called while the file lock is held and after the
      // file has been read, so it is the seam where a missing lock shows up: the
      // second edit would read stale content and its write would clobber the first.
      const firstInside = yield* Deferred.make<void>()
      const secondInside = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let calls = 0
      const ask: Tool.Context["ask"] = () =>
        Effect.gen(function* () {
          calls += 1
          if (calls === 1) {
            yield* Deferred.succeed(firstInside, undefined)
            yield* Deferred.await(release)
            return
          }
          yield* Deferred.succeed(secondInside, undefined)
        })

      const fiberA = yield* run({ filePath: filepath, oldString: "alpha", newString: "ALPHA" }, ctx({ ask })).pipe(
        Effect.forkChild,
      )
      yield* Deferred.await(firstInside)

      const fiberB = yield* run({ filePath: filepath, oldString: "beta", newString: "BETA" }, ctx({ ask })).pipe(
        Effect.forkChild,
      )

      // Negative check: while the first edit holds the lock the second edit must
      // not have reached its prompt. Timeout is the assertion here, same shape as
      // the "stream stays open" test in test/server/httpapi-event.test.ts.
      const early = yield* Deferred.await(secondInside).pipe(Effect.timeoutOption("300 millis"))
      expect(Option.isNone(early)).toBe(true)

      yield* Deferred.succeed(release, undefined)
      const [resultA, resultB] = yield* Effect.all([Fiber.join(fiberA), Fiber.join(fiberB)])

      expect(resultA.metadata.diff).toContain("ALPHA")
      expect(resultB.metadata.diff).toContain("BETA")
      expect(yield* load(filepath)).toBe("ALPHA\nBETA\n")
      expect(calls).toBe(2)
      expect(testFileLocks.size).toBe(0)
    }),
  )

  it.instance("keeps one referenced entry while concurrent edits of the same file are in flight", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "shared-two.txt")
      yield* put(filepath, "alpha\nbeta\n")

      const firstInside = yield* Deferred.make<void>()
      const openFirst = yield* Deferred.make<void>()
      const openSecond = yield* Deferred.make<void>()
      let calls = 0
      const ask: Tool.Context["ask"] = () =>
        Effect.gen(function* () {
          calls += 1
          if (calls === 1) {
            yield* Deferred.succeed(firstInside, undefined)
            yield* Deferred.await(openFirst)
            return
          }
          yield* Deferred.await(openSecond)
        })

      const fiberA = yield* run({ filePath: filepath, oldString: "alpha", newString: "ALPHA" }, ctx({ ask })).pipe(
        Effect.forkChild,
      )
      yield* Deferred.await(firstInside)
      const fiberB = yield* run({ filePath: filepath, oldString: "beta", newString: "BETA" }, ctx({ ask })).pipe(
        Effect.forkChild,
      )

      // The second caller must join the first one's entry instead of creating
      // another, and must keep it alive while it waits for the permit.
      yield* pollWithTimeout(
        Effect.sync(() => (Array.from(testFileLocks.values())[0]?.refs === 2 ? true : undefined)),
        "second edit never joined the first edit's lock entry",
      )
      expect(testFileLocks.size).toBe(1)

      yield* Deferred.succeed(openFirst, undefined)
      yield* Deferred.succeed(openSecond, undefined)
      yield* Fiber.join(fiberA)
      yield* Fiber.join(fiberB)
      expect(yield* load(filepath)).toBe("ALPHA\nBETA\n")
      expect(testFileLocks.size).toBe(0)
    }),
  )
})
