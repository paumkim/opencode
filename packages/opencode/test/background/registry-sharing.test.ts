import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { locationServices } from "@opencode-ai/core/location-services"
import { Node } from "@opencode-ai/core/effect/app-node"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@opencode-ai/core/config"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { FanoutTool } from "@opencode-ai/core/tool/fanout"
import { BackgroundJob } from "@/background/job"
import { locationServiceReplacements } from "@/server/routes/instance/httpapi/server"
import { testEffect } from "../lib/effect"

/**
 * `FanoutTool` is a Location node, so it reaches `BackgroundJob` through the
 * Location graph's own hoisted globals -- a graph `LayerNode.compile` builds
 * independently of the application group. Two graphs means two registries, and a
 * v1 abort of a parent session enumerates the application graph's registry to
 * cancel its background work, so a crew the tool started would be invisible to
 * it.
 *
 * Both graphs are built here, exactly as production builds them, and the
 * assertion is that a job registered from inside the Location graph is visible
 * to the application-level service. A test that built only one of the two would
 * pass whether or not the wiring is right.
 */
const directory = AbsolutePath.make(process.cwd())

const locationMap = buildLocationServiceMap([
  [PermissionV2.node, Layer.mock(PermissionV2.Service, {})],
  [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
  [Snapshot.node, Snapshot.noopLayer],
  [SessionRunnerModel.node, Layer.mock(SessionRunnerModel.Service, {})],
  // THE LINE UNDER TEST: production's own replacement list, so a change that
  // drops the shared registry is caught here too.
  ...locationServiceReplacements(),
])

const it = testEffect(Layer.mergeAll(LayerNode.compile(BackgroundJob.node), locationMap))

describe("BackgroundJob registry sharing", () => {
  it.effect("production's Location graph resolves the application registry, not a second one", () =>
    Effect.gen(function* () {
      // Identity, not name: `hoist` is what the Location graph does to the
      // application's globals, and a same-named different node is the bug.
      const { hoisted } = LayerNode.hoist(
        locationServices,
        Node.tags.values.global,
        locationServiceReplacements().concat([[Location.node, Location.boundNode({ directory })]]),
      )
      const resolved = hoisted.dependencies.find((node) => node.name === CoreBackgroundJob.node.name)
      expect(resolved).toBe(BackgroundJob.node)
    }),
  )

  it.instance("a job registered from a Location graph is visible to the application graph", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const locations = yield* LocationServiceMap.Service
      const ref = Location.Ref.make({ directory })

      // Register from inside the Location graph, the way `FanoutTool` does. A
      // Location-scoped caller has no `InstanceRef`, so this also covers the
      // registry keying that has to survive it.
      yield* Effect.gen(function* () {
        const registry = yield* BackgroundJob.Service
        yield* registry.start({
          id: "ses_child",
          type: FanoutTool.name,
          metadata: { sessionId: "ses_child", parentSessionId: "ses_parent" },
          run: Effect.never,
        })
      }).pipe(Effect.provide(locations.get(ref)))

      // ...and enumerate from the application graph, the way an abort does.
      const listed = yield* jobs.list()
      expect(listed.map((job) => job.id)).toEqual(["ses_child"])
      expect(listed[0]?.metadata).toMatchObject({ sessionId: "ses_child", parentSessionId: "ses_parent" })
      expect((yield* jobs.get("ses_child"))?.status).toBe("running")

      // And cancelling through the application graph reaches the Location
      // graph's job, which is the whole point of sharing one registry.
      yield* jobs.cancel("ses_child")
      expect((yield* jobs.get("ses_child"))?.status).toBe("cancelled")
    }),
  )
})
