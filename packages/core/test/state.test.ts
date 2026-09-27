import { describe, expect } from "bun:test"
import { State } from "@opencode-ai/core/state"
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("State", () => {
  it.effect("commits a transform atomically when its updater is interrupted", () =>
    Effect.gen(function* () {
      const rebuilding = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let block = true
      const state = State.create({
        initial: () => ({ values: [] as string[] }),
        draft: (draft) => ({ add: (value: string) => draft.values.push(value) }),
        finalize: () =>
          block ? Deferred.succeed(rebuilding, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void,
      })
      const scope = yield* Scope.make()
      const fiber = yield* state
        .transform((editor) => {
          editor.add("registered")
        })
        .pipe(Scope.provide(scope), Effect.forkChild)
      yield* Deferred.await(rebuilding)
      const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
      block = false
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interruption)

      expect(state.get().values).toEqual(["registered"])
      yield* Scope.close(scope, Exit.void)
      expect(state.get().values).toEqual([])
    }),
  )

  it.effect("runs effectful transforms during every reload", () =>
    Effect.gen(function* () {
      let value = "first"
      const state = State.create({
        initial: () => ({ values: [] as string[] }),
        draft: (draft) => ({ add: (item: string) => draft.values.push(item) }),
      })

      yield* state.transform((editor) =>
        Effect.sync(() => {
          editor.add(value)
        }),
      )
      expect(state.get().values).toEqual(["first"])

      value = "second"
      yield* state.reload()
      expect(state.get().values).toEqual(["second"])
    }),
  )

  it.effect("disposes a transform once and rebuilds remaining state", () =>
    Effect.gen(function* () {
      const state = State.create({
        initial: () => ({ values: [] as string[] }),
        draft: (draft) => ({ add: (item: string) => draft.values.push(item) }),
      })
      yield* state.transform((editor) => {
        editor.add("first")
      })
      const registration = yield* state.transform((editor) => {
        editor.add("second")
      })
      expect(state.get().values).toEqual(["first", "second"])

      yield* registration.dispose
      expect(state.get().values).toEqual(["first"])

      yield* registration.dispose
      expect(state.get().values).toEqual(["first"])
    }),
  )

  it.effect("batches automatic rebuilds", () =>
    Effect.gen(function* () {
      let finalized = 0
      const first = State.create({
        initial: () => ({ values: [] as string[] }),
        draft: (draft) => ({ add: (item: string) => draft.values.push(item) }),
        finalize: () => Effect.sync(() => finalized++),
      })
      const second = State.create({
        initial: () => ({ values: [] as string[] }),
        draft: (draft) => ({ add: (item: string) => draft.values.push(item) }),
        finalize: () => Effect.sync(() => finalized++),
      })

      yield* State.batch(
        Effect.gen(function* () {
          yield* first.transform((draft) => {
            draft.add("first")
          })
          yield* first.transform((draft) => {
            draft.add("second")
          })
          yield* second.transform((draft) => {
            draft.add("third")
          })
          expect(finalized).toBe(0)
        }),
      )

      expect(first.get().values).toEqual(["first", "second"])
      expect(second.get().values).toEqual(["third"])
      expect(finalized).toBe(2)
    }),
  )

  it.effect("materializes a transform registered by a fiber that outlives its batch", () =>
    Effect.gen(function* () {
      const state = State.create({
        initial: () => ({ values: [] as string[] }),
        draft: (draft) => ({ add: (value: string) => draft.values.push(value) }),
      })

      const started = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()

      // A plugin may fork while a batch is open and finish loading later. The forked fiber
      // inherits the batch reference, but the batch has already drained by then, so queueing the
      // reload on it would drop the transform: the domain would never rebuild and the plugin's
      // contribution would silently never appear.
      yield* State.batch(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            Effect.gen(function* () {
              yield* Deferred.await(go)
              yield* state.transform((draft) => {
                draft.add("forked")
              })
              yield* Deferred.succeed(started, undefined)
            }),
          )
        }),
      )

      // The enclosing batch is over before the fork registers anything.
      expect(state.get().values).toEqual([])

      yield* Deferred.succeed(go, undefined)
      yield* Deferred.await(started)
      expect(state.get().values).toEqual(["forked"])
    }),
  )
})
