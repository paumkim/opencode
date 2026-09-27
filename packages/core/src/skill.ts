export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Option, Schema, Types } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { FSUtil } from "./fs-util"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { State } from "./state"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny")

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)
// Decoding the whole frontmatter block is all-or-nothing, so one wrong-typed value used to drop
// the skill entirely: `slash: "yes"` instead of `slash: true` cost the user the skill's name, its
// description and its body, with nothing to explain why. Decode the keys individually so a bad one
// is dropped and the skill still loads, and name what was dropped so the typo is visible.
const decodeFields = new Map(
  Object.entries(Frontmatter.fields).map(([key, field]) => [key, Schema.decodeUnknownOption(field, { errors: "all" })]),
)

function decodeSkillFrontmatter(data: Record<string, unknown>) {
  const decoded = decodeFrontmatter(data)
  if (Option.isSome(decoded)) return { info: decoded.value, rejected: [] as string[] }
  const kept: Record<string, unknown> = {}
  const rejected: string[] = []
  for (const [key, value] of Object.entries(data)) {
    const decodeField = decodeFields.get(key)
    // An unknown key is not an error: frontmatter is a Struct, so excess keys are ignored and a
    // skill file may legitimately carry fields this build does not read.
    if (!decodeField) continue
    const field = decodeField(value)
    if (Option.isSome(field)) kept[key] = field.value
    else rejected.push(key)
  }
  return {
    // Every value in `kept` came out of that key's own decoder, so the record is already valid;
    // the cast only recovers the constructor's static type, which a per-key loop cannot express.
    info: Frontmatter.make(kept as { name?: string; description?: string; slash?: boolean }),
    rejected,
  }
}

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service

    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        list: () => draft.sources as Source[],
      }),
    })

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      const skills: Info[] = []
      if (source.type === "embedded") return [source.skill]
      const directories = source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      for (const directory of directories) {
        const files = yield* fs
          .glob("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const filepath of files.toSorted()) {
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!content) continue
          const markdown = ConfigMarkdown.parseOption(content)
          // A frontmatter that does not parse is a mistake the user can fix, and it used to skip in
          // total silence even though a file with a merely wrong-typed KEY reports itself below -- the
          // more broken a file was, the quieter the loader got.
          if (!markdown) {
            yield* Effect.logWarning("ignoring unparseable skill frontmatter", { path: filepath })
            continue
          }
          const { info: frontmatter, rejected } = decodeSkillFrontmatter(markdown.data)
          if (rejected.length > 0) {
            // No `name` here: the skill's name is derived from the frontmatter below, so reporting
            // the filename would be misleading noise. The path identifies the skill unambiguously.
            yield* Effect.logWarning("ignoring invalid skill frontmatter", {
              path: filepath,
              keys: rejected.join(", "),
            })
          }
          const name =
            frontmatter.name !== undefined
              ? frontmatter.name
              : path.dirname(filepath) === directory
                ? path.basename(filepath, ".md")
                : undefined
          if (!name) continue
          skills.push({
            name,
            description: frontmatter.description,
            slash: frontmatter.slash,
            location: AbsolutePath.make(filepath),
            content: markdown.content,
          })
        }
      }
      return skills
    })

    // QUESTION(Dax): Should local skill sources invalidate on filesystem watch
    // events, following the reload policy chosen for other context sources?
    const cache = new Map<string, Info[]>()
    const list = Effect.fn("SkillV2.list")(function* () {
      const skills = new Map<string, Info>()
      for (const source of state.get().sources) {
        const key = Source.key(source)
        const loaded = cache.get(key) ?? (yield* load(source))
        cache.set(key, loaded)
        for (const skill of loaded) skills.set(skill.name, skill)
      }
      return Array.from(skills.values())
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SkillDiscovery.node, FSUtil.node] })
