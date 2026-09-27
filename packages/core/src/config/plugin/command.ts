export * as ConfigCommandPlugin from "./command"

import { define } from "../../plugin/internal"
import path from "path"
import { Effect, Option, Schema } from "effect"

import { Config } from "../../config"
import { FSUtil } from "../../fs-util"
import { ModelV2 } from "../../model"
import { ConfigCommand } from "../command"
import { ConfigMarkdown } from "../markdown"

const decodeCommand = Schema.decodeUnknownOption(ConfigCommand.Info)
// Decoding the whole frontmatter block is all-or-nothing, so one wrong-typed value used to make
// the command vanish from the list with nothing to explain why. `subtask: "yes"` instead of
// `subtask: true` is an easy mistake to make and it cost the user the entire file. Decode the
// frontmatter keys individually so a bad one is dropped and the command still registers, and name
// what was dropped so the typo is visible.
const decodeFields = new Map(
  Object.entries(ConfigCommand.Info.fields).map(([key, field]) => [
    key,
    Schema.decodeUnknownOption(field, { errors: "all" }),
  ]),
)

function decodeInfo(template: string, data: Record<string, unknown>) {
  const decoded = decodeCommand({ ...data, template })
  if (Option.isSome(decoded)) return { info: decoded.value, rejected: [] as string[] }
  // `template` is the only required key and it is derived from the markdown body rather than from
  // frontmatter, so it is always a string and always survives.
  const kept: Record<string, unknown> = { template }
  const rejected: string[] = []
  for (const [key, value] of Object.entries(data)) {
    const decodeField = decodeFields.get(key)
    // An unknown key is not an error: frontmatter is a Struct, so excess keys are ignored and a
    // command file may legitimately carry fields this build does not read.
    if (!decodeField) continue
    const field = decodeField(value)
    if (Option.isSome(field)) kept[key] = field.value
    else rejected.push(key)
  }
  return {
    // Every value in `kept` came out of that key's own decoder, so the record is already valid;
    // the cast only recovers the constructor's static type, which a per-key loop cannot express.
    info: new ConfigCommand.Info(kept as ConstructorParameters<typeof ConfigCommand.Info>[0]),
    rejected,
  }
}

export const Plugin = define({
  id: "config-command",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    yield* ctx.command.transform(
      Effect.fn(function* (draft) {
        const documents = yield* Effect.forEach(yield* config.entries(), (entry) => {
          if (entry.type === "document") return Effect.succeed([{ commands: entry.info.commands }])
          return loadDirectory(fs, entry.path).pipe(
            Effect.map((commands) => [
              { commands: Object.fromEntries(commands.map((command) => [command.name, command.info])) },
            ]),
          )
        }).pipe(Effect.map((documents) => documents.flat()))
        for (const document of documents) {
          for (const [name, command] of Object.entries(document.commands ?? {})) {
            draft.update(name, (item) => {
              item.template = command.template
              if (command.description !== undefined) item.description = command.description
              if (command.agent !== undefined) item.agent = command.agent
              if (command.model !== undefined) {
                const model = ModelV2.parse(command.model)
                item.model = { id: model.modelID, providerID: model.providerID, variant: item.model?.variant }
              }
              if (command.variant !== undefined && item.model !== undefined) {
                item.model.variant = ModelV2.VariantID.make(command.variant)
              }
              if (command.subtask !== undefined) item.subtask = command.subtask
            })
          }
        }
      }),
    )
  }),
})

function loadDirectory(fs: FSUtil.Interface, directory: string) {
  return Effect.gen(function* () {
    const files = yield* fs
      .glob("{command,commands}/**/*.md", { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    return yield* Effect.forEach(files.toSorted(), (filepath) =>
      fs.readFileStringSafe(filepath).pipe(
        Effect.flatMap((content) => {
          if (content === undefined) return Effect.succeed(undefined)
          const decoded = decode(directory, filepath, content)
          if (decoded.type === "unparseable")
            return Effect.logWarning("ignoring unparseable command frontmatter", { path: filepath }).pipe(
              Effect.as(undefined),
            )
          if (decoded.type === "none") return Effect.succeed(undefined)
          const entry = { name: decoded.name, info: decoded.info }
          if (!decoded.rejected.length) return Effect.succeed(entry)
          // Report the keys that did not decode, so a command that behaves differently from what
          // the file says is at least traceable to the file.
          return Effect.logWarning("ignoring invalid command frontmatter", {
            path: filepath,
            name: decoded.name,
            keys: decoded.rejected.join(", "),
          }).pipe(Effect.as(entry))
        }),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
    ).pipe(
      Effect.map((commands) =>
        commands.filter((command): command is { name: string; info: ConfigCommand.Info } => command !== undefined),
      ),
    )
  })
}

// `unparseable` is separated from `none` on purpose: a frontmatter that does not parse is a mistake
// the user can fix, and it used to be dropped in total silence even though a file with a merely
// wrong-typed KEY reports itself below -- the more broken a file was, the quieter the loader got.
function decode(directory: string, filepath: string, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return { type: "unparseable" as const }
  const decoded = decodeInfo(markdown.content.trim(), markdown.data as Record<string, unknown>)
  if (!decoded) return { type: "none" as const }
  return {
    type: "document" as const,
    name: path
      .relative(directory, filepath)
      .replaceAll("\\", "/")
      .replace(/^(command|commands)\//, "")
      .replace(/\.md$/, ""),
    ...decoded,
  }
}
