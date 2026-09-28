import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Cause, Effect, Layer } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { ApiInstanceLoadError } from "../errors"
import { WorkspaceRouteContext } from "./workspace-routing"

/**
 * Resolves the instance a request is about, and declares what happens when that
 * cannot be done.
 *
 * `InstanceStore.load` has no typed error channel — a failed bootstrap reaches
 * its caller as a defect, and a defect is not part of any endpoint's contract.
 * The failure is real and reachable (an unreadable directory, a database error, a
 * plugin that throws while bootstrapping), so it is declared here rather than
 * left to surface as a bare 500 that no client and no OpenAPI document
 * accounts for. Declaring it on the middleware rather than per endpoint covers
 * every group that requires an instance, which is the point: a client that
 * cannot read `/path` cannot be trusted about the directory it is in either.
 */
export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiInstanceContext", { error: ApiInstanceLoadError }) {}

function decode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E | ApiInstanceLoadError, WorkspaceRouteContext> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const directory = decode(route.directory)
    // `orDie` inside the store makes every load failure a defect, so the cause is
    // walked here to turn it back into a typed, documented failure. Left as a
    // defect it reaches the client as a bare 500 that no contract accounts for.
    const ctx = yield* store.load({ directory }).pipe(
      Effect.catchCause((cause) => {
        const die = cause.reasons.find(Cause.isDieReason)
        const fail = cause.reasons.find(Cause.isFailReason)
        const reason: unknown = die?.defect ?? fail?.error
        const message = reason instanceof Error ? reason.message : "Failed to load instance"
        return Effect.logError("instance load failed", { directory, cause }).pipe(
          Effect.andThen(
            Effect.fail(
              new ApiInstanceLoadError({
                name: "InstanceLoadError",
                data: { message, directory },
              }),
            ),
          ),
        )
      }),
    )
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store))
  }),
)
