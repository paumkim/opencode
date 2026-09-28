import { expect, test } from "bun:test"
import { Cause, Effect, Logger } from "effect"
import { SessionRunnerLLM } from "../../src/session/runner/llm"
import { RelativePath } from "../../src/schema"

const from = "snap_start" as never
const to = "snap_end" as never

const paths = (items: string[]) => items as unknown as readonly RelativePath[]

const snapshots = (effect: Effect.Effect<readonly RelativePath[], unknown>) =>
  ({ files: () => effect }) as unknown as Parameters<typeof SessionRunnerLLM.stepFileChanges>[0]

type Captured = { readonly text: string; readonly annotations: Record<string, unknown> }

/**
 * Runs the effect with a logger that collects instead of printing, so the warning is observable.
 *
 * `log.message` is a pair - the rendered text and an annotations object - and the annotations are kept
 * structured rather than stringified. `JSON.stringify` of a `Cause` holding an `Error` yields
 * `{"failures":[{"error":{}}]}` because a message is non-enumerable, so asserting the *cause text*
 * against a serialised log would be a test of the serialiser rather than of the code under test. The
 * cause is squashed back to its `Error` instead.
 */
const withCapturedLogs = <A, E>(effect: Effect.Effect<A, E>) => {
  const entries: Captured[] = []
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Logger.layer([
          Logger.make((log) => {
            const [text, annotations] = log.message as [string, Record<string, unknown>]
            entries.push({ text, annotations })
          }),
        ]) as never,
      ),
    ),
  ).then((value) => ({ value, entries }))
}

test("a failed snapshot diff is reported rather than presented as a step that changed nothing", async () => {
  // The regression: the list was `snapshots.files(...).pipe(Effect.catch(() => Effect.succeed(undefined)))`.
  // `Step.Ended.files` is the per-step list of what the step touched, so a dropped list tells the user
  // the step changed no files - and a step that edited files looks like it edited none, with nothing
  // anywhere saying the list is missing rather than empty.
  const { value, entries } = await withCapturedLogs(
    SessionRunnerLLM.stepFileChanges(snapshots(Effect.fail(new Error("snapshot store unavailable"))), from, to),
  )

  expect(value).toBeUndefined()
  const warning = entries.find((entry) => entry.text.includes("could not list the files"))
  expect(warning).toBeDefined()
  // The two snapshot ids, so a reader can tell which step lost its list.
  expect(warning?.annotations.from).toBe("snap_start")
  expect(warning?.annotations.to).toBe("snap_end")
  // And the reason, recovered rather than serialised.
  const cause = warning?.annotations.cause as Cause.Cause<unknown>
  expect(String(Cause.squash(cause))).toContain("snapshot store unavailable")
})

test("a step with no snapshots to compare is not reported - nothing to compare is a real answer", async () => {
  // The other direction, and the one a warning-everywhere fix would break. `capture()` returning
  // nothing means snapshots are disabled, which is a normal configuration and not a fault, so a
  // warning here would train people to ignore the real one.
  for (const [a, b] of [
    [undefined, to],
    [from, undefined],
    [undefined, undefined],
  ] as const) {
    const { value, entries } = await withCapturedLogs(
      SessionRunnerLLM.stepFileChanges(snapshots(Effect.succeed(paths(["a.ts"]))), a as never, b as never),
    )
    expect(value).toBeUndefined()
    expect(entries).toEqual([])
  }
})

test("a step whose snapshot succeeded reports the paths it changed and nothing at all", async () => {
  const { value, entries } = await withCapturedLogs(
    SessionRunnerLLM.stepFileChanges(snapshots(Effect.succeed(paths(["a.ts", "b.ts"]))), from, to),
  )
  expect(value).toEqual(paths(["a.ts", "b.ts"]))
  expect(entries).toEqual([])
})
