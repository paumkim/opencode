import { afterEach, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import * as PlatformError from "effect/PlatformError"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { disposeAllInstances } from "../fixture/fixture"
import { Env } from "@/env"
import { Plugin } from "@/plugin/index"
import { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"

/**
 * `defaultModel` decides which model runs a session's FIRST prompt, and its answer is recorded on the
 * user message and the session row. So the difference between "I looked and there is nothing" and "I
 * could not look" is the difference between a fresh install and a durable record of a model the user
 * never chose.
 *
 * These tests use a config-defined provider so the result is a plain assertion about which model was
 * picked, with no dependency on models.dev or the network.
 */
const customProviderConfig = {
  provider: {
    "custom-provider": {
      name: "Custom Provider",
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.custom.com/v1",
      models: {
        // The naming is load-bearing. `Provider.sort` orders by id DESCENDING, so the provider's
        // default is the HIGHEST id. Naming the recents target the lowest id therefore makes the
        // default and the recents provably different models, so a substitution cannot pass for
        // correct behaviour.
        //
        // This is not hypothetical: the first version of this file named them the other way round and
        // the fallback returned the same id as the recents, so the regression proof could show only
        // that an error appeared, not that a different model had been chosen.
        "model-a": { name: "Model A" },
        "model-z": { name: "Model Z" },
      },
      options: { apiKey: "custom-key" },
    },
  },
}

const MODEL_STATE = path.join(Global.Path.state, "model.json")

/**
 * The real `FSUtil` with `model.json` redirected to a value the test controls.
 *
 * A hand-written failure is used rather than chmod-ing a real file because the point is which error
 * the *caller* distinguishes. `PlatformError.systemError` with a `PermissionDenied` tag and an EACCES
 * cause is what `FSUtil` actually produces for a permissions failure, and it is materially different
 * from a `SyntaxError` (a corrupt file, which the reader is entitled to repair) and from `NotFound` (a
 * first run, which genuinely means no recents).
 */
function stateFs(contents: () => "missing" | "unreadable" | { recent: unknown[] }) {
  return Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        readJson: (file) => {
          if (file !== MODEL_STATE) return fs.readJson(file)
          const state = contents()
          if (state === "missing")
            return Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "readJson",
                pathOrDescriptor: file,
              }),
            )
          if (state === "unreadable")
            return Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "readJson",
                pathOrDescriptor: file,
                cause: Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
              }),
            )
          return Effect.succeed(contents())
        },
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
}

const withState = (contents: () => "missing" | "unreadable" | { recent: unknown[] }) =>
  testEffect(
    LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node]), [[FSUtil.node, stateFs(contents)]]),
  )

const unreadable = withState(() => "unreadable")
const missing = withState(() => "missing")
const withRecent = (modelID: string) => withState(() => ({ recent: [{ providerID: "custom-provider", modelID }] }))

afterEach(async () => {
  await disposeAllInstances()
})

test("the state file the tests redirect is the one production reads", () => {
  // Guards the whole file against a silent redirect: if the production path ever moves, every test
  // below would still pass while testing nothing.
  const source = require("node:fs").readFileSync(
    path.join(import.meta.dir, "../../src/provider/provider.ts"),
    "utf8",
  ) as string
  expect(source).toContain('path.join(Global.Path.state, "model.json")')
})

unreadable.instance(
  "refuses to choose a model rather than substituting one the user did not pick",
  Effect.gen(function* () {
    const error = yield* Provider.use.defaultModel().pipe(Effect.flip)
    // The defect: this used to succeed, returning the first configured model as though the user had
    // no recents, and the caller recorded that on the session.
    expect(error).toBeInstanceOf(Provider.ModelStateUnreadableError)
    expect(error._tag).toBe("ProviderModelStateUnreadableError")
    // The message has to say what refusing protects. "EACCES" alone does not tell a user whose model
    // just changed why it did not.
    expect(error.message).toContain("model.json")
    expect(error.message).toContain("did not pick")
    // The errno is the part that identifies the problem, and it is nested at `reason.cause` inside a
    // PlatformError, so it only appears if the describer walked in.
    expect(error.message).toContain("EACCES")
  }),
  { config: customProviderConfig },
)

unreadable.instance(
  "is a different failure from NoProvidersError, so callers can tell them apart",
  Effect.gen(function* () {
    const error = yield* Provider.use.defaultModel().pipe(Effect.flip)
    // Both mean "no model", and the previous behaviour reported this one as a clean fallback. Keeping
    // them distinct is the whole point: a caller that wants to treat a genuine absence differently
    // from an unanswered question has to be able to.
    expect(error).not.toBeInstanceOf(Provider.NoProvidersError)
    expect(error).not.toBeInstanceOf(Provider.NoModelsError)
  }),
  { config: customProviderConfig },
)

missing.instance(
  "still falls back to a model when the file is genuinely absent",
  Effect.gen(function* () {
    // A first run is not a failure. Refusing here would mean no model on a clean install at all, which
    // is a worse bug than the one being fixed.
    const model = yield* Provider.use.defaultModel()
    expect(String(model.providerID)).toBe("custom-provider")
    // Pins the fallback to a DIFFERENT model than the recents test selects, so the two paths can never
    // be confused for each other.
    expect(String(model.modelID)).toBe("model-z")
  }),
  { config: customProviderConfig },
)

withRecent("model-a").instance(
  "prefers the recently-used model when the file is readable",
  Effect.gen(function* () {
    // The behaviour that makes the refusal worth anything: with a readable file the recents still win.
    const model = yield* Provider.use.defaultModel()
    expect(String(model.modelID)).toBe("model-a")
  }),
  { config: customProviderConfig },
)
