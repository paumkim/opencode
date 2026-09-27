export * as ConfigAgentPlugin from "./agent"

import { define } from "../../plugin/internal"
import path from "path"
import { Effect, Option, Schema } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { ConfigAgent } from "../agent"
import { ConfigMarkdown } from "../markdown"
import { FSUtil } from "../../fs-util"
import { ModelV2 } from "../../model"
import { ConfigAgentV1 } from "../../v1/config/agent"
import { ConfigMigrateV1 } from "../../v1/config/migrate"
import { Global } from "../../global"
import { PermissionV2 } from "../../permission"
import type { LocationMutation } from "../../location-mutation"
import type { ReadTool } from "../../tool/read"
import type { EditTool } from "../../tool/edit"

const legacySources = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const
const decodeAgent = Schema.decodeUnknownOption(ConfigAgent.Info)
const decodeLegacyAgent = Schema.decodeUnknownOption(ConfigAgentV1.Info)
const decodeConfig = Schema.decodeUnknownOption(Config.Info)
type PathAction =
  | LocationMutation.ExternalDirectoryAuthorization["action"]
  | typeof ReadTool.name
  | typeof EditTool.name
const pathActions = ["external_directory", "read", "edit"] as const satisfies readonly PathAction[]
// Keys that only ConfigAgentV1.Info accepts. A markdown agent is migrated from V1 when it uses one
// of these. This has to be a positive list, not "any key ConfigAgent.Info does not contain": an
// unknown key is far more often a typo in a V2 agent than evidence of a V1 one, and guessing V1
// routes the file through ConfigMigrateV1.migrateAgent, which drops every V2 field. A typo'd
// `permisions` therefore arrived as an agent with no permission rules at all. Note `disable` (V1)
// and `disabled` (V2) are distinct keys on purpose, so each is detected on its own side.
const legacyAgentKeys = new Set([
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "prompt",
  "tools",
  "disable",
  "options",
  "maxSteps",
  "permission",
])

export const Plugin = define({
  id: "config-agent",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    yield* ctx.agent.transform(
      Effect.fn(function* (draft) {
        const documents = yield* Effect.forEach(yield* config.entries(), (entry) => {
          if (entry.type === "document") return Effect.succeed([entry])
          return Effect.gen(function* () {
            const files = yield* discover(fs, entry.path)
            return yield* Effect.forEach(files, (file) =>
              fs.readFileStringSafe(file.filepath).pipe(
                Effect.flatMap((content) => {
                  if (content === undefined) return Effect.succeed(undefined)
                  const decoded = decode(file, content)
                  if (decoded.type === "unparseable")
                    return Effect.logWarning("ignoring unparseable agent frontmatter", {
                      path: file.filepath,
                    }).pipe(Effect.as(undefined))
                  if (decoded.type === "none") return Effect.succeed(undefined)
                  if (!decoded.rejected.length) return Effect.succeed(decoded.document)
                  // Report the keys that did not decode, so an agent that behaves differently from
                  // what the file says is at least traceable to the file.
                  return Effect.logWarning("ignoring invalid agent frontmatter", {
                    path: file.filepath,
                    name: decoded.name,
                    keys: decoded.rejected.join(", "),
                  }).pipe(Effect.as(decoded.document))
                }),
                Effect.catch(() => Effect.succeed(undefined)),
              ),
            ).pipe(
              Effect.map((documents) =>
                documents.filter((document): document is Config.Document => document !== undefined),
              ),
            )
          })
        }).pipe(Effect.map((documents) => documents.flat()))
        const permissions = expandPermissions(
          documents.flatMap((document) => document.info.permissions ?? []),
          global.home,
        )
        const configuredDefault = Config.latest(documents, "default_agent")
        if (configuredDefault !== undefined) draft.default(AgentV2.ID.make(configuredDefault))
        for (const current of draft.list()) {
          draft.update(current.id, (agent) => agent.permissions.push(...permissions))
        }

        for (const document of documents) {
          for (const [id, item] of Object.entries(document.info.agents ?? {})) {
            const agentID = AgentV2.ID.make(id)
            if (item.disabled) {
              draft.remove(agentID)
              continue
            }

            const exists = draft.get(agentID) !== undefined
            draft.update(agentID, (agent) => {
              if (!exists) agent.permissions.push(...permissions)
              if (item.model !== undefined) {
                const model = ModelV2.parse(item.model)
                agent.model = { id: model.modelID, providerID: model.providerID, variant: agent.model?.variant }
              }
              if (item.variant !== undefined && agent.model !== undefined) {
                agent.model.variant = ModelV2.VariantID.make(item.variant)
              }
              if (item.request !== undefined) {
                Object.assign(agent.request.headers, item.request.headers ?? {})
                Object.assign(agent.request.body, item.request.body ?? {})
              }
              if (item.system !== undefined) agent.system = item.system
              if (item.context !== undefined) agent.context = item.context
              if (item.description !== undefined) agent.description = item.description
              if (item.mode !== undefined) agent.mode = item.mode
              if (item.hidden !== undefined) agent.hidden = item.hidden
              if (item.color !== undefined) agent.color = item.color
              if (item.steps !== undefined) agent.steps = item.steps
              if (item.permissions !== undefined) {
                agent.permissions.push(...expandPermissions(item.permissions, global.home))
              }
            })
          }
        }
      }),
    )
  }),
})

function expandPermissions(rules: PermissionV2.Ruleset, home: string): PermissionV2.Ruleset {
  // Expand only resources tools resolve as filesystem paths. Bash resources are raw shell text:
  // rewriting `$HOME/private/**` would miss `$HOME/private/key`, and safe expansion needs shell-aware parsing.
  return rules.map((rule) =>
    isPathAction(rule.action) ? { ...rule, resource: expandHome(rule.resource, home) } : rule,
  )
}

function isPathAction(action: string): action is PathAction {
  return pathActions.some((item) => item === action)
}

function expandHome(resource: string, home: string) {
  if (resource.startsWith("~/")) return home + resource.slice(1)
  if (resource === "~") return home
  if (resource === "$HOME") return home
  if (resource.startsWith("$HOME/")) return home + resource.slice(5)
  if (resource.startsWith("$HOME\\")) return home + resource.slice(5)
  return resource
}

function discover(fs: FSUtil.Interface, directory: string) {
  return Effect.forEach(legacySources, (source) =>
    fs
      .glob(source.pattern, { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(
        Effect.map((files) => files.toSorted().map((filepath) => ({ directory, filepath, primary: source.primary }))),
      ),
  ).pipe(
    Effect.map((files) => files.flat()),
    Effect.catch(() => Effect.succeed([])),
  )
}

// `unparseable` is separated from `none` on purpose. A file whose frontmatter does not parse is a
// mistake the user can fix, and it used to be dropped in total silence even though a file with a
// merely wrong-typed KEY right below reports itself -- so the more broken a file was, the quieter the
// loader got, which is backwards.
type Decoded =
  | { type: "document"; document: Config.Document; name: string; rejected: string[] }
  | { type: "none" }
  | { type: "unparseable" }

function decode(file: { directory: string; filepath: string; primary: boolean }, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return { type: "unparseable" as const }
  const name = path
    .relative(file.directory, file.filepath)
    .replaceAll("\\", "/")
    .replace(/^(agent|agents|mode|modes)\//, "")
    .replace(/\.md$/, "")
  const body = markdown.content.trim()
  const legacy = Object.keys(markdown.data).some((key) => legacyAgentKeys.has(key))
  // Decoding the whole frontmatter at once is all-or-nothing, so one wrong-typed value used to make
  // the agent vanish with nothing to explain why: `hidden: "yes"` instead of `hidden: true` is an
  // easy mistake and it cost the user the entire file. Nothing in a V2 agent is required -- the
  // markdown body is the prompt, and every frontmatter key is a setting on top of it -- so probe the
  // keys one at a time and keep the ones that decode, dropping only what cannot. A key is kept only
  // if the object still decodes with it, so a key that is individually valid but invalid in
  // combination with an earlier one is dropped too. An unknown key is not an error: an agent file
  // may legitimately carry fields this build does not read.
  const attempt = (data: Record<string, unknown>) =>
    Option.getOrUndefined(
      legacy
        ? Option.map(
            decodeLegacyAgent({ name, ...data, prompt: body }, { errors: "all", propertyOrder: "original" }),
            ConfigMigrateV1.migrateAgent,
          )
        : decodeAgent({ ...data, system: body }, { errors: "all", propertyOrder: "original" }),
    )
  const agent = attempt(markdown.data)
  if (agent) return finish(file, agent, name, [])
  // One or more keys did not decode. Probe them one at a time, keeping each only if the object
  // still decodes with it, so a key that is individually valid but invalid in combination with an
  // earlier one is dropped too. A key that cannot be added is rejected by name.
  const kept: Record<string, unknown> = {}
  const rejected: string[] = []
  for (const key of Object.keys(markdown.data)) {
    const candidate = { ...kept, [key]: markdown.data[key] }
    if (attempt(candidate)) kept[key] = markdown.data[key]
    else rejected.push(key)
  }
  const recovered = attempt(kept)
  if (!recovered) return { type: "none" as const }
  return finish(file, recovered, name, rejected)
}

// A recovered agent is either a decoded V2 agent or the V1 migration's plain object, depending on
// which decoder the file's keys selected.
type AttemptedAgent = ConfigAgent.Info | ReturnType<typeof ConfigMigrateV1.migrateAgent>

function finish(
  file: { directory: string; filepath: string; primary: boolean },
  agent: AttemptedAgent,
  name: string,
  rejected: string[],
): Decoded {
  const info = Option.getOrUndefined(
    decodeConfig({
      agents: { [name]: file.primary ? { ...agent, mode: "primary" } : agent },
    }),
  )
  if (!info) return { type: "none" as const }
  return {
    type: "document" as const,
    document: new Config.Document({ type: "document", path: file.filepath, info }),
    name,
    rejected,
  }
}
