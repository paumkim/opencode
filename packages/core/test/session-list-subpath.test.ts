import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { Location } from "@opencode-ai/core/location"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

// Every directory resolves to one project rooted at `/project`, so a session's
// subpath is its directory relative to that root.
const root = AbsolutePath.make("/project")
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: () => Effect.succeed({ id: ProjectV2.ID.global, directory: root }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)

const at = (relative: string) => Location.Ref.make({ directory: AbsolutePath.make(path.join(root, relative)) })

const subpaths = (sessions: readonly { subpath?: string }[]) =>
  sessions.map((session) => session.subpath).sort((a, b) => String(a).localeCompare(String(b)))

describe("SessionV2.list subpath", () => {
  it.effect("limits a project listing to the requested subpath and its children", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const project = ProjectV2.ID.global

      const rootSession = yield* session.create({ location: at("") })
      const pkg = yield* session.create({ location: at("pkg") })
      const deep = yield* session.create({ location: at("pkg/deep") })
      const other = yield* session.create({ location: at("other") })
      // `my-pkg` and `pctXdir` are the same length as `my_pkg` and `pct%dir` and
      // differ only where a LIKE wildcard would match anything.
      const underscoreSibling = yield* session.create({ location: at("my-pkg") })
      const underscore = yield* session.create({ location: at("my_pkg") })
      // Nested, so matching it has to go through the LIKE branch rather than the
      // exact-path comparison.
      const underscoreDeep = yield* session.create({ location: at("my_pkg/deep") })
      const percent = yield* session.create({ location: at("pct%dir") })
      const percentDeep = yield* session.create({ location: at("pct%dir/deep") })
      const percentSibling = yield* session.create({ location: at("pctXdir/deep") })

      // A project holds every directory beneath it, so the unfiltered listing is
      // the whole set.
      expect(yield* session.list({ project })).toHaveLength(10)

      expect(subpaths(yield* session.list({ project, subpath: RelativePath.make("pkg") }))).toEqual(["pkg", "pkg/deep"])
      expect(subpaths(yield* session.list({ project, subpath: RelativePath.make("pkg/deep") }))).toEqual(["pkg/deep"])
      expect(subpaths(yield* session.list({ project, subpath: RelativePath.make("other") }))).toEqual(["other"])

      // `_` and `%` are LIKE wildcards. `my_pkg/deep` and `pct%dir/deep` are what
      // pin the escape down: without it the pattern matches nothing at all, and
      // without escaping it also swallows the same-length wildcard siblings.
      expect(subpaths(yield* session.list({ project, subpath: RelativePath.make("my_pkg") }))).toEqual([
        "my_pkg",
        "my_pkg/deep",
      ])
      expect(subpaths(yield* session.list({ project, subpath: RelativePath.make("pct%dir") }))).toEqual([
        "pct%dir",
        "pct%dir/deep",
      ])

      // Every session is still individually reachable, so the filter above
      // narrowed a listing rather than losing rows.
      expect(yield* session.list({ project, limit: 100 })).toHaveLength(10)
      expect([
        rootSession.id,
        pkg.id,
        deep.id,
        other.id,
        underscore.id,
        underscoreSibling.id,
        underscoreDeep.id,
        percent.id,
        percentDeep.id,
        percentSibling.id,
      ]).toHaveLength(10)
    }),
  )

  it.effect("returns nothing for a subpath no session occupies", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const project = ProjectV2.ID.global

      yield* session.create({ location: at("pkg") })

      expect(yield* session.list({ project, subpath: RelativePath.make("missing") })).toEqual([])
    }),
  )

  it.effect("does not let a subpath filter match a sibling sharing its prefix", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const project = ProjectV2.ID.global

      yield* session.create({ location: at("pkg") })
      // `pkgs` shares a prefix with `pkg` but is not below it.
      yield* session.create({ location: at("pkgs") })

      expect(subpaths(yield* session.list({ project, subpath: RelativePath.make("pkg") }))).toEqual(["pkg"])
    }),
  )
})
