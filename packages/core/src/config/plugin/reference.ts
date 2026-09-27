export * as ConfigReferencePlugin from "./reference"

import { define } from "../../plugin/internal"
import path from "path"
import { Effect } from "effect"
import { Config } from "../../config"
import { ConfigReference } from "../reference"
import { Reference } from "../../reference"
import { AbsolutePath } from "../../schema"
import { Global } from "../../global"
import { Location } from "../../location"

export const Plugin = define({
  id: "core/config-reference",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const global = yield* Global.Service
    yield* ctx.reference.transform(
      Effect.fn(function* (draft) {
        const entries = new Map<string, Reference.Source>()
        for (const doc of (yield* config.entries()).filter(
          (entry): entry is Config.Document => entry.type === "document",
        )) {
          const directory = doc.path ? path.dirname(doc.path) : location.directory
          for (const [name, entry] of Object.entries(doc.info.references ?? {})) {
            if (!validAlias(name)) continue
            const description = typeof entry === "string" ? undefined : entry.description
            const hidden = typeof entry === "string" ? undefined : entry.hidden
            entries.set(
              name,
              local(entry)
                ? Reference.LocalSource.make({
                    type: "local",
                    path: AbsolutePath.make(
                      localPath(directory, global.home, typeof entry === "string" ? entry : entry.path),
                    ),
                    ...(description === undefined ? {} : { description }),
                    ...(hidden === undefined ? {} : { hidden }),
                  })
                : Reference.GitSource.make({
                    type: "git",
                    repository: typeof entry === "string" ? entry : entry.repository,
                    ...(entry.branch === undefined ? {} : { branch: entry.branch }),
                    ...(description === undefined ? {} : { description }),
                    ...(hidden === undefined ? {} : { hidden }),
                  }),
            )
          }
        }
        for (const [name, source] of entries) draft.add(name, source)
      }),
    )
  }),
})

function validAlias(name: string) {
  return name.length > 0 && !/[/\s`,]/.test(name)
}

function local(entry: ConfigReference.Entry): entry is string | ConfigReference.Local {
  return typeof entry === "string" ? entry.startsWith(".") || entry.startsWith("~") || absolute(entry) : "path" in entry
}

// `references` decides between a directory on disk and a repository to clone by looking at the
// string alone, so the answer must not depend on which host is reading the config. Testing for a
// leading `/` only knows the posix shape: `C:\repos\thing` and `\\fileserver\share\thing` are the
// absolute paths a Windows author writes, and neither starts with `/`, so both were classified as
// repository URLs and sent to `git clone`. Ask about each shape explicitly instead — these are pure
// string checks, so the same input classifies the same way everywhere.
function absolute(value: string) {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
}

function localPath(directory: string, home: string, value: string) {
  if (value.startsWith("~/")) return path.join(home, value.slice(2))
  // An absolute path names one location outright, so it is never resolved against the config
  // directory. That also keeps an absolute path intact when a config is read on a host that would
  // otherwise rewrite it as a relative segment.
  return absolute(value) ? value : path.resolve(directory, value)
}
