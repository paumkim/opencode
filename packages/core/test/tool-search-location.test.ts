import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobTool } from "@opencode-ai/core/tool/glob"
import { GrepTool } from "@opencode-ai/core/tool/grep"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"
import { SessionV2 } from "@opencode-ai/core/session"

/**
 * `glob` and `grep` resolve their search root through `fs.realPath` before handing it to ripgrep,
 * but they used to relativize the results against the *unresolved* `location.directory`. The two
 * agree only when the location is not a symlink.
 */
const symlinked = async (tmp: { path: string }) => {
  const real = path.join(tmp.path, "real")
  const link = path.join(tmp.path, "link")
  await fs.mkdir(path.join(real, "src"), { recursive: true })
  await fs.writeFile(path.join(real, "src", "a.ts"), "const needle = 1\n")
  await fs.writeFile(path.join(real, "b.md"), "# b\n")
  await fs.symlink(real, link)
  return { real, link }
}

const locationLayer = (directory: string) =>
  Layer.succeed(
    Location.Service,
    Location.Service.of({
      directory: AbsolutePath.make(directory),
      workspaceID: "default",
      project: { id: Project.ID.global, directory: AbsolutePath.make(directory) },
    } as Location.Interface),
  )

/** Both tools ask permission before searching; these tests are about the reported paths, so allow. */
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const layer = (directory: string) =>
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, GlobTool.node, GrepTool.node]), [
    [Location.node, locationLayer(directory)],
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ])

const reported = (name: string, input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const settlement = yield* settleTool(registry, {
      ...toolIdentity,
      sessionID: SessionV2.ID.make("ses_tool_search_location"),
      call: { type: "tool-call", id: `call_${name}`, name, input },
    })
    // `grep` yields Matches wrapping an `entry`; `glob` yields bare Entries.
    return ((settlement.output?.structured ?? []) as { entry?: { path?: string }; path?: string }[]).map(
      (row) => row.entry?.path ?? row.path,
    )
  })

const withLocation = (directory: string) =>
  Effect.gen(function* () {
    const globbed = yield* reported("glob", { pattern: "**/*.ts" }).pipe(Effect.provide(layer(directory)))
    const grepped = yield* reported("grep", { pattern: "needle" }).pipe(Effect.provide(layer(directory)))
    return { globbed, grepped }
  })

const scoped = <A, E, R>(use: (tmp: { path: string }) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => use(tmp)))

/** A `RelativePath` that points inside the location: not absolute, and no leading `..`. */
const expectContained = (paths: readonly (string | undefined)[]) => {
  for (const reportedPath of paths) {
    expect(path.isAbsolute(String(reportedPath))).toBe(false)
    expect(path.normalize(String(reportedPath)).startsWith("..")).toBe(false)
  }
}

const expectSrcATs = (globbed: readonly (string | undefined)[], grepped: readonly (string | undefined)[]) => {
  expect(globbed).toEqual([RelativePath.make("src/a.ts")])
  expect(grepped).toEqual([RelativePath.make("src/a.ts")])
  expectContained([...globbed, ...grepped])
}

describe("glob and grep report location-relative paths", () => {
  testEffect(Layer.empty).live("when the location directory is a symlink to the project", () =>
    scoped((tmp) =>
      Effect.gen(function* () {
        const { link } = yield* Effect.promise(() => symlinked(tmp))
        const { globbed, grepped } = yield* withLocation(link)
        // `link/src/a.ts` and `real/src/a.ts` are the same file, so the location-relative path is
        // `src/a.ts`. Relativizing the realpath result against the symlinked `location.directory`
        // instead produced `../real/src/a.ts`, a path that climbs out of the location root and does
        // not exist relative to it.
        //
        // `RelativePath` is a bare string brand (packages/schema/src/schema.ts:6), so nothing
        // downstream rejects the escape: `path.resolve(location.directory, escaped)` happens to land
        // on the right file again, but the value handed to the model, the client, and the
        // snapshot/ignore predicates that test for a leading `..` all claim the file sits outside the
        // location it was searched in.
        expectSrcATs(globbed, grepped)
      }),
    ),
  )

  testEffect(Layer.empty).live("and are unchanged when the location is already a realpath", () =>
    scoped((tmp) =>
      Effect.gen(function* () {
        const { real } = yield* Effect.promise(() => symlinked(tmp))
        const { globbed, grepped } = yield* withLocation(real)
        // The two bases are identical here, which is why the existing suite never saw the defect.
        // This pins that relativizing against `root` does not change the common case.
        expectSrcATs(globbed, grepped)
      }),
    ),
  )
})
