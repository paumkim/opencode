import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Location } from "@opencode-ai/core/location"
import { Flag } from "@opencode-ai/core/flag/flag"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const ORIGINAL_DISABLE_FFF = Flag.OPENCODE_DISABLE_FFF

const provide = (directory: string) =>
  Effect.provide(
    LayerNode.compile(FileSystem.node, [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ],
    ]),
  )

const withTmp = <A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))

describe("FileSystem", () => {
  it.live("reads text and binary files", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "text.txt"), "hello"))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "data.bin"), Buffer.from([0, 1, 2])))
        const service = yield* FileSystem.Service
        const text = yield* service.read({ path: RelativePath.make("text.txt") })
        const binary = yield* service.read({ path: RelativePath.make("data.bin") })
        expect(new TextDecoder().decode(text.content)).toBe("hello")
        expect(text.mime).toBe("text/plain")
        expect(binary.content).toEqual(new Uint8Array([0, 1, 2]))
      }).pipe(provide(directory)),
    ),
  )

  it.live("lists direct children", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "README.md"), "# Test"))
        const entries = yield* (yield* FileSystem.Service).list()
        expect(entries.map((entry) => ({ path: entry.path, type: entry.type }))).toEqual([
          { path: RelativePath.make("src" + path.sep), type: "directory" },
          { path: RelativePath.make("README.md"), type: "file" },
        ])
      }).pipe(provide(directory)),
    ),
  )

  it.live("rejects lexical escapes", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const result = yield* (yield* FileSystem.Service)
          .read({ path: RelativePath.make("../outside.txt") })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
      }).pipe(provide(directory)),
    ),
  )

  // `list` already rejected these; nothing pinned it, so the guard could be dropped silently.
  it.live("rejects lexical escapes from list too", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const result = yield* (yield* FileSystem.Service).list({ path: RelativePath.make("../") }).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
      }).pipe(provide(directory)),
    ),
  )

  const seedEscape = (directory: string) =>
    Effect.gen(function* () {
      const outside = path.join(directory, "..", path.basename(directory) + "-outside")
      yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(path.join(outside, "leaked.txt"), "secret"))
      // A symlink that stays lexically inside the location but resolves out of it: only the
      // realpath half of the guard catches this one.
      yield* Effect.promise(() => fs.symlink(outside, path.join(directory, "escape")))
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "inside.txt"), "visible"))
    })

  const assertEscapesRejected = Effect.fnUntraced(function* (service: FileSystem.Interface) {
    // The four attempts are heterogeneous (glob yields Entry[], grep yields Match[]), so the
    // array needs a widened element type to be yield*-able in one loop.
    const attempts: Effect.Effect<unknown, unknown>[] = [
      service.glob({ path: RelativePath.make("../"), pattern: "*" }),
      service.grep({ path: RelativePath.make("../"), pattern: "secret" }),
      service.glob({ path: RelativePath.make("escape"), pattern: "*" }),
      service.grep({ path: RelativePath.make("escape"), pattern: "secret" }),
    ]
    for (const attempt of attempts) {
      expect(Exit.isFailure(yield* attempt.pipe(Effect.exit))).toBe(true)
    }
  })

  it.live("rejects lexical and symlink escapes from glob and grep", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* seedEscape(directory)
        const service = yield* FileSystem.Service
        yield* assertEscapesRejected(service)
        // The control only asserts acceptance: the fff index is empty in a freshly created
        // tmpdir, so there is no content to find here and no such assertion to make.
        expect(Exit.isSuccess(yield* service.glob({ pattern: "*" }).pipe(Effect.exit))).toBe(true)
        expect(Exit.isSuccess(yield* service.grep({ pattern: "visible" }).pipe(Effect.exit))).toBe(true)
      }).pipe(provide(directory)),
    ),
  )

  it.live("rejects the same escapes on the ripgrep-backed layer", () =>
    Effect.gen(function* () {
      const previous = Flag.OPENCODE_DISABLE_FFF
      Flag.OPENCODE_DISABLE_FFF = true
      return yield* withTmp((directory) =>
        Effect.gen(function* () {
          yield* seedEscape(directory)
          const service = yield* FileSystem.Service
          yield* assertEscapesRejected(service)
          // ripgrep does walk the location, so this layer also proves the guard did not break
          // the working path. It matters that the guard is tested on *both* layers: the service
          // picks fff whenever `Fff.available()`, so a guard added only to `ripgrepLayer` is
          // silently inert and this test would not have noticed.
          expect((yield* service.glob({ pattern: "*.txt" })).map((entry) => entry.path)).toEqual([
            RelativePath.make("inside.txt"),
          ])
          expect((yield* service.grep({ pattern: "visible" })).map((match) => match.entry.path)).toEqual([
            RelativePath.make("inside.txt"),
          ])
        }).pipe(provide(directory)),
      )
    }).pipe(Effect.ensuring(Effect.sync(() => (Flag.OPENCODE_DISABLE_FFF = ORIGINAL_DISABLE_FFF)))),
  )
})
