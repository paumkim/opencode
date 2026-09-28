import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { createVariantRuntime } from "@/cli/cmd/run/variant.shared"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../../fixture/fixture"
import * as PlatformError from "effect/PlatformError"

const model = { providerID: "openai", modelID: "gpt-4.1" } as never

/**
 * The real `FSUtil` with `model.json` remapped into a temp dir, and `readJson` optionally failing the
 * way a locked or partially-written file would - with a code that is not ENOENT, so the reader
 * cannot treat it as a first run.
 */
function remappedFs(root: string, readFails?: () => "permission" | "unparsable" | undefined) {
  const remap = (file: string) =>
    file === path.join(Global.Path.state, "model.json") ? path.join(root, "m.json") : file
  return Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        readJson: (file) =>
          readFails?.() === "permission"
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readJson",
                  pathOrDescriptor: "model.json",
                  cause: Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
                }),
              )
            : readFails?.() === "unparsable"
              ? Effect.fail(
                  // `InvalidData` is the right normalized tag - the file parsed to something
                  // impossible - and the point of the test is that the SyntaxError reaches
                  // `isUnparsable` wrapped inside it.
                  PlatformError.systemError({
                    _tag: "InvalidData",
                    module: "FileSystem",
                    method: "readJson",
                    pathOrDescriptor: "model.json",
                    cause: new SyntaxError("JSON Parse error: Expected '}'"),
                  }),
                )
              : fs.readJson(remap(file)),
        writeJson: (file, data, mode) => fs.writeJson(remap(file), data, mode),
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
}

describe("run variant save with an unreadable model.json", () => {
  test("refuses to save rather than writing a store it could not read", async () => {
    // The defect. `model.json` is shared with the TUI, which writes `recent`, `favorite` and
    // `variant` into it, and `saveVariant` wrote back the object it had read. The read caught every
    // failure into `state(undefined)` - `{}` - so a transient failure turned a variant save into a
    // write of `{ variant: ... }` and silently discarded the user's entire recently-used model list
    // and every favourite. `recent` is not cosmetic: it is the last fallback in `subagent-failover`'s
    // model chain, and `defaultModel` reads it too.
    await using tmp = await tmpdir<{ file: string }>({ init: async (dir) => ({ file: path.join(dir, "m.json") }) })
    const file = tmp.extra.file
    await Bun.write(file, JSON.stringify({ recent: [{ providerID: "anthropic", modelID: "sonnet" }], favorite: ["a"] }))

    const svc = createVariantRuntime(remappedFs(tmp.path, () => "permission"))
    await expect(svc.saveVariant(model, "high")).rejects.toThrow(/Refusing to continue/)

    // The user's data is intact, which is the whole point.
    expect(await Bun.file(file).json()).toEqual({
      recent: [{ providerID: "anthropic", modelID: "sonnet" }],
      favorite: ["a"],
    })
  })

  test("the refusal names the file and the cause", async () => {
    // "EACCES" alone does not tell a reader why saving a variant was refused, and the consequence is
    // the actionable part.
    await using tmp = await tmpdir<{ file: string }>({ init: async (dir) => ({ file: path.join(dir, "m.json") }) })
    const svc = createVariantRuntime(remappedFs(tmp.path, () => "permission"))
    await expect(svc.saveVariant(model, "high")).rejects.toThrow(/EACCES/)
    await expect(svc.saveVariant(model, "high")).rejects.toThrow(/recently-used models and favourites/)
  })

  test("an absent file is still a first run, not a refusal", async () => {
    // The direction that must not regress: ENOENT means nothing has been written yet, and failing
    // there would make it impossible to ever save the first variant.
    await using tmp = await tmpdir<{ file: string }>({ init: async (dir) => ({ file: path.join(dir, "m.json") }) })
    const svc = createVariantRuntime(remappedFs(tmp.path))
    await svc.saveVariant(model, "high")
    expect((await Bun.file(tmp.extra.file).json()).variant).toEqual({ "openai/gpt-4.1": "high" })
  })

  test("a successful save preserves the keys it does not own", async () => {
    // The behaviour that makes the refusal necessary: on the happy path the file must round-trip.
    await using tmp = await tmpdir<{ file: string }>({ init: async (dir) => ({ file: path.join(dir, "m.json") }) })
    await Bun.write(
      tmp.extra.file,
      JSON.stringify({ recent: [{ providerID: "anthropic", modelID: "sonnet" }], favorite: ["a"] }),
    )
    const svc = createVariantRuntime(remappedFs(tmp.path))
    await svc.saveVariant(model, "high")
    expect(await Bun.file(tmp.extra.file).json()).toEqual({
      recent: [{ providerID: "anthropic", modelID: "sonnet" }],
      favorite: ["a"],
      variant: { "openai/gpt-4.1": "high" },
    })
  })

  test("resolving a saved variant tolerates the same failure, because nothing is written after it", async () => {
    // The asymmetry is deliberate and worth pinning: `resolveSavedVariant` only reads, so a failure
    // costs a default and no data, while `saveVariant` writes and therefore has to refuse. Making
    // both strict would break resolution for no safety gain; making both tolerant is the defect.
    await using tmp = await tmpdir<{ file: string }>({ init: async (dir) => ({ file: path.join(dir, "m.json") }) })
    const svc = createVariantRuntime(remappedFs(tmp.path, () => "permission"))
    expect(await svc.resolveSavedVariant(model)).toBeUndefined()
  })

  test("a CORRUPT file is still repaired, because it holds nothing to lose", async () => {
    // The distinction this unit turns on, and an existing test ("repairs malformed saved variant state
    // on the next write") is what caught me getting it wrong the first time. Refusing on a parse error
    // would disable the feature permanently: every future write also fails to read the file, so the
    // user could never save a variant again. Overwriting a corrupt file destroys nothing that still
    // exists.
    await using tmp = await tmpdir<{ file: string }>({ init: async (dir) => ({ file: path.join(dir, "m.json") }) })
    await Bun.write(tmp.extra.file, "{")

    const svc = createVariantRuntime(remappedFs(tmp.path, () => "unparsable"))
    await svc.saveVariant(model, "high")
    expect(await Bun.file(tmp.extra.file).json()).toEqual({ variant: { "openai/gpt-4.1": "high" } })
  })
})
