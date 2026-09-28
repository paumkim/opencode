export * as SessionRunCoordinator from "./run-coordinator"

import { Deferred, Effect, Exit, Fiber, FiberSet, Scope, Semaphore } from "effect"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
}

/** The idle boundary of a key: it started executing, or it stopped for good. */
export type Phase<E> = { readonly type: "started" } | { readonly type: "ended"; readonly exit: Exit.Exit<void, E> }

type Entry<E> = {
  readonly done: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<void>
  pendingWake: boolean
  stopping: boolean
}

export const make = <Key, E>(options: {
  readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>
  /**
   * Reported when `key` gains its first execution and when it releases its last.
   *
   * Announcements pass through a single permit because a wake that lands while
   * the idle phase is still being published starts the next turn immediately.
   * The permit is what makes the two phases reach a subscriber in the order the
   * coordinator decided them: without it a client could be told a Session went
   * idle *after* it went busy, and would latch busy for the life of the page.
   */
  readonly lifecycle?: (key: Key, phase: Phase<E>) => Effect.Effect<void>
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    const permit = yield* Semaphore.make(1)

    const makeEntry = (): Entry<E> => ({
      done: Deferred.makeUnsafe<void, E>(),
      pendingWake: false,
      stopping: false,
    })

    const announce = (key: Key, phase: Phase<E>) =>
      Effect.suspend(() => {
        if (options.lifecycle === undefined) return Effect.void
        return permit.withPermits(1)(
          options
            .lifecycle!(key, phase)
            .pipe(Effect.catchCause((cause) => Effect.logError("Session execution phase was not reported", cause))),
        )
      })

    const start = (key: Key, entry: Entry<E>, force: boolean, successor = false) => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(Effect.suspend(() => options.drain(key, force))),
          Effect.onExit((exit) => Effect.suspend(() => settle(key, entry, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<E>, exit: Exit.Exit<void, E>) =>
      Effect.gen(function* () {
        if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
          entry.pendingWake = false
          start(key, entry, false, true)
          return
        }

        const successor = entry.pendingWake ? makeEntry() : undefined
        if (successor === undefined) {
          active.delete(key)
          // Announced before the key is released to its waiters, so a `run`
          // that starts the next turn is announced after this one.
          yield* announce(key, { type: "ended", exit })
          Deferred.doneUnsafe(entry.done, exit)
          return
        }
        active.set(key, successor)
        start(key, successor, false, true)
        Deferred.doneUnsafe(entry.done, exit)
      })

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))))
          return restore(Deferred.await(entry.done))
        }

        const next = makeEntry()
        active.set(key, next)
        return announce(key, { type: "started" }).pipe(
          // Announced before the drain is released, so a turn that settles in
          // the same instant is never reported ahead of the start it belongs to.
          Effect.andThen(Effect.sync(() => start(key, next, true))),
          Effect.andThen(restore(Deferred.await(next.done))),
        )
      })

    const wake = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry !== undefined) {
          entry.pendingWake = true
          return Effect.void
        }

        const next = makeEntry()
        active.set(key, next)
        return Effect.uninterruptible(
          announce(key, { type: "started" }).pipe(Effect.andThen(Effect.sync(() => start(key, next, false)))),
        )
      })

    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined) return Effect.void
        entry.stopping = true
        entry.pendingWake = false
        return Fiber.interrupt(entry.owner)
      })

    return { active: Effect.sync(() => new Set(active.keys())), run, wake, interrupt }
  })
