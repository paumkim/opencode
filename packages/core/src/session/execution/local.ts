import { Cause, Effect, Exit, Layer } from "effect"
import { EventV2 } from "../../event"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionEvent } from "../event"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const events = yield* EventV2.Service

    const drain = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force: boolean) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
        Effect.provide(locations.get(session.location)),
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
        ),
      )
    })

    /**
     * The v2 runtime's only "this Session is busy" / "it is idle again" signal.
     *
     * A client latches busy the first time a turn starts and can only be
     * released by this, so it is published from the coordinator's own
     * boundaries rather than inferred from message events. The Session's
     * Location is attached explicitly: the coordinator runs above the Location
     * graph, and the event stream filters by directory, so an event without one
     * would reach nobody.
     */
    const report = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      phase: SessionRunCoordinator.Phase<SessionRunner.RunError>,
    ) {
      const session = yield* store.get(sessionID)
      const options = session === undefined ? undefined : { location: session.location }
      if (phase.type === "started") {
        yield* events.publish(SessionEvent.Execution.Started, { sessionID }, options)
        return
      }
      const { exit } = phase
      if (Exit.isSuccess(exit)) {
        yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID }, options)
        return
      }
      if (Cause.hasInterruptsOnly(exit.cause)) {
        // Every current caller of `SessionExecution.interrupt` is an explicit
        // abort, and a scope close tears the coordinator down without ever
        // reaching here.
        yield* events.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "user" }, options)
        return
      }
      yield* events.publish(SessionEvent.Execution.Failed, { sessionID, error: failure(exit.cause) }, options)
    })

    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain,
      lifecycle: report,
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
    })
  }),
)

const failure = (cause: Cause.Cause<SessionRunner.RunError>): SessionEvent.UnknownError => {
  const error = Cause.squash(cause)
  return { type: "unknown", message: error instanceof Error ? error.message : String(error) }
}

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node, EventV2.node],
})

export * as SessionExecutionLocal from "./local"
