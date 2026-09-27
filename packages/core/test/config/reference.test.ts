import { describe, expect } from "bun:test"
import os from "os"
import path from "path"
import { Effect, Schema } from "effect"
import type { PluginContext } from "@opencode-ai/plugin/v2/effect"
import type { ReferenceSource } from "@opencode-ai/sdk/v2/types"
import { Config } from "@opencode-ai/core/config"
import { ConfigReferencePlugin } from "@opencode-ai/core/config/plugin/reference"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node, Global.node])))
const decode = Schema.decodeUnknownSync(Config.Info)

const registration = { dispose: Effect.void }

type ReferenceDraft = Parameters<Parameters<PluginContext["reference"]["transform"]>[0]>[0]

// The plugin decides what kind of source each reference is and hands it to the reference domain.
// Recording the draft keeps the assertion on that decision — the thing under test — instead of on
// the reference store that receives it.
function recordingHost(sources: Map<string, ReferenceSource>) {
  const draft: ReferenceDraft = {
    add: (name, source) => void sources.set(name, source),
    remove: (name) => void sources.delete(name),
    list: () => Array.from(sources.entries()),
  }
  return host({
    reference: {
      transform: (callback) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.void)
          yield* Effect.suspend(() => callback(draft) ?? Effect.void)
          return registration
        }),
      reload: () => Effect.void,
    },
  })
}

const directory = os.tmpdir()

function load(references: Record<string, unknown>) {
  return Effect.gen(function* () {
    const global = yield* Global.Service
    const sources = new Map<string, ReferenceSource>()
    const config = Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            path: path.join(directory, "opencode.json"),
            info: decode({ references }),
          }),
        ]),
    })

    yield* ConfigReferencePlugin.Plugin.effect(recordingHost(sources)).pipe(
      Effect.provideService(Config.Service, config),
      Effect.provideService(Location.Service, { directory: AbsolutePath.make(directory) } as never),
    )

    return { sources, home: global.home }
  })
}

describe("ConfigReferencePlugin.Plugin", () => {
  it.effect("treats Windows absolute reference paths as local directories, not repositories", () =>
    Effect.gen(function* () {
      const { sources } = yield* load({
        drive: "C:\\repos\\thing",
        driveSlash: "D:/repos/thing",
        unc: "\\\\fileserver\\share\\thing",
      })

      // None of these start with `.`, `/` or `~`, so the classifier used to fall through to the
      // repository branch and hand a bare Windows path to `git clone`. A drive-letter path and a
      // UNC share are the two absolute shapes a Windows author writes, and each must survive as
      // the directory it names.
      expect(sources.get("drive")).toEqual({ type: "local", path: "C:\\repos\\thing" })
      expect(sources.get("driveSlash")).toEqual({ type: "local", path: "D:/repos/thing" })
      expect(sources.get("unc")).toEqual({ type: "local", path: "\\\\fileserver\\share\\thing" })
    }),
  )

  it.effect("leaves an absolute reference path unresolved against the config directory", () =>
    Effect.gen(function* () {
      const { sources } = yield* load({ abs: "/srv/repos/thing", win: "C:\\repos\\thing" })

      // An absolute path names one location outright. Resolving it against the config directory
      // would rewrite `C:\repos\thing` into `<config dir>/C:\repos\thing`, because a Windows path
      // is not absolute to the posix host doing the resolving.
      expect(sources.get("abs")).toEqual({ type: "local", path: "/srv/repos/thing" })
      expect(sources.get("win")).toEqual({ type: "local", path: "C:\\repos\\thing" })
    }),
  )

  it.effect("resolves relative and home-relative reference paths against the config directory", () =>
    Effect.gen(function* () {
      const { sources, home } = yield* load({ sibling: "./sibling", homeRel: "~/repos/thing" })

      expect(sources.get("sibling")).toEqual({ type: "local", path: path.resolve(directory, "sibling") })
      expect(sources.get("homeRel")).toEqual({ type: "local", path: path.join(home, "repos/thing") })
    }),
  )

  it.effect("keeps classifying repository references as repositories", () =>
    Effect.gen(function* () {
      const { sources } = yield* load({
        https: "https://github.com/anomalyco/repo",
        ssh: "git@github.com:anomalyco/repo.git",
        short: "github.com/anomalyco/repo",
      })

      // Widening what counts as a path must not capture anything a URL could look like.
      expect(sources.get("https")).toEqual({ type: "git", repository: "https://github.com/anomalyco/repo" })
      expect(sources.get("ssh")).toEqual({ type: "git", repository: "git@github.com:anomalyco/repo.git" })
      expect(sources.get("short")).toEqual({ type: "git", repository: "github.com/anomalyco/repo" })
    }),
  )
})
