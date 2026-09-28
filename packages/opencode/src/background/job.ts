import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { Location } from "@opencode-ai/core/location"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Layer } from "effect"

export {
  Service,
  type ExtendInput,
  type Info,
  type Interface,
  type StartInput,
  type Status,
  type WaitInput,
  type WaitResult,
} from "@opencode-ai/core/background-job"

/**
 * One registry per directory, whichever graph asked for it.
 *
 * The instance cache and the Location graph key on the same string, so a job
 * registered by a Location-scoped tool (fan-out's crew) and a job registered by
 * an instance-scoped service land in the SAME registry. That has to be true:
 * `LayerNode.compile` builds each root independently, and a v1 abort enumerates
 * this registry to cancel a session's background work -- so a crew the fan-out
 * tool started would be invisible to aborting its parent.
 */
const directory = Effect.gen(function* () {
  const instance = yield* InstanceRef
  if (instance) return instance.directory
  // A Location-scoped caller has no InstanceRef, but it does know which
  // directory it is running for.
  const location = yield* Effect.serviceOption(Location.Service)
  if (location._tag === "Some") return location.value.directory
  return yield* Effect.die(new Error("InstanceRef not provided"))
})

/** Keeps the legacy service instance-scoped while sharing the core registry engine. */
const layer = Layer.effect(
  CoreBackgroundJob.Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(() => CoreBackgroundJob.make, directory)
    return CoreBackgroundJob.Service.of({
      list: () => InstanceState.useEffect(state, (jobs) => jobs.list()),
      get: (id) => InstanceState.useEffect(state, (jobs) => jobs.get(id)),
      start: (input) => InstanceState.useEffect(state, (jobs) => jobs.start(input)),
      extend: (input) => InstanceState.useEffect(state, (jobs) => jobs.extend(input)),
      wait: (input) => InstanceState.useEffect(state, (jobs) => jobs.wait(input)),
      waitForPromotion: (id) => InstanceState.useEffect(state, (jobs) => jobs.waitForPromotion(id)),
      promote: (id) => InstanceState.useEffect(state, (jobs) => jobs.promote(id)),
      cancel: (id) => InstanceState.useEffect(state, (jobs) => jobs.cancel(id)),
    })
  }),
)

/**
 * Tagged `global` and named after the core service, so it can *replace* the
 * core node inside a Location graph. The Location graph hoists global nodes into
 * a graph of its own, and `LayerNode.compile` builds each root independently --
 * so without the replacement the fan-out tool would own a second registry that
 * the v1 abort path cannot see.
 */
export const node = makeGlobalNode({ service: CoreBackgroundJob.Service, layer, deps: [] })

export * as BackgroundJob from "./job"
