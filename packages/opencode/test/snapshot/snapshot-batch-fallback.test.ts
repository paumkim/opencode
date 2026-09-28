import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer, Logger } from "effect"
import { ChildProcess } from "effect/unstable/process"
import path from "path"
import { Snapshot } from "../../src/snapshot"
import { disposeAllInstances, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const realProcess = LayerNode.compile(AppProcess.node)

// `git cat-file --batch` answers with a line protocol that diffFull parses itself.
// Anything else forces it down the per-file `git show` fallback, and a fallback
// that produces the same diff either way is invisible -- so the log line is the
// only place the reason can surface. This stub hands back a header git would
// never emit, and the test asserts on both halves: the diff is still correct,
// and the reason reached the log.
const unparseableBatchLayer = Layer.effect(
  AppProcess.Service,
  Effect.gen(function* () {
    const real = yield* AppProcess.Service
    return AppProcess.Service.of({
      ...real,
      run: (command, options) =>
        real
          .run(command, options)
          .pipe(
            Effect.map((result) =>
              ChildProcess.isStandardCommand(command) && command.args.includes("cat-file")
                ? { ...result, stdout: Buffer.from("this-is-not-a-cat-file-header\n") }
                : result,
            ),
          ),
    })
  }),
).pipe(Layer.provide(realProcess))

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node]), [[AppProcess.node, unparseableBatchLayer]]),
    testInstanceStoreLayer,
  ),
)

const UNPARSEABLE_HEADER =
  "git cat-file --batch returned an unexpected header during snapshot diff, falling back to per-file git show"

it.instance(
  "diffFull logs the reason it fell back to per-file git show",
  Effect.gen(function* () {
    const tmp = yield* TestInstance
    const fs = yield* FSUtil.Service
    const snapshot = yield* Snapshot.Service

    yield* fs.writeWithDirs(path.join(tmp.directory, "a.txt"), "before\n")
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    yield* fs.writeWithDirs(path.join(tmp.directory, "a.txt"), "after\n")
    const after = yield* snapshot.track()
    expect(after).toBeTruthy()

    const messages: unknown[] = []
    const diffs = yield* snapshot.diffFull(before!, after!).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make<unknown, void>((options) => {
            messages.push(options.message)
          }),
        ]),
      ),
    )

    // The fallback is a performance path, not a correctness one: the diff it
    // builds one `git show` at a time has to be the diff the batch would have.
    expect(diffs).toHaveLength(1)
    expect(diffs[0].file).toBe("a.txt")
    expect(diffs[0].status).toBe("modified")
    expect(diffs[0].patch).toContain("-before")
    expect(diffs[0].patch).toContain("+after")

    expect(messages.filter((item) => Array.isArray(item) && item[0] === UNPARSEABLE_HEADER)).toEqual([
      [UNPARSEABLE_HEADER, expect.objectContaining({ head: "this-is-not-a-cat-file-header" })],
    ])
  }),
  { git: true },
)
