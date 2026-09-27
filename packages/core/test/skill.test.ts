import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const urls = new Map<string, AbsolutePath[]>()
let pulls = 0
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({
    pull: (url) => {
      pulls++
      return Effect.succeed(urls.get(url) ?? [])
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, AgentV2.node]), [[SkillDiscovery.node, discovery]]),
)

function write(directory: string, name: string, description: string) {
  return fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}`,
  )
}

describe("SkillV2", () => {
  it.live("registers sources and resolves later source precedence", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(second, "review", "Second")
            await fs.writeFile(path.join(first, "foo.md"), "---\nslash: true\n---\n# foo")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(second) })
            expect(editor.list()).toEqual([
              { type: "directory", path: AbsolutePath.make(first) },
              { type: "directory", path: AbsolutePath.make(second) },
            ])
          })

          expect(yield* skill.sources()).toEqual([
            { type: "directory", path: AbsolutePath.make(first) },
            { type: "directory", path: AbsolutePath.make(second) },
          ])
          expect(yield* skill.list()).toEqual([
            SkillV2.Info.make({
              name: "foo",
              slash: true,
              location: AbsolutePath.make(path.join(first, "foo.md")),
              content: "# foo",
            }),
            {
              name: "review",
              description: "Second",
              location: AbsolutePath.make(path.join(second, "review", "SKILL.md")),
              content: "# review",
            },
          ])
        }),
      ),
    ),
  )

  it.live("loads URL sources and filters skills for agents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Deploy production")
          })
          pulls = 0
          urls.set("https://example.test/skills/", [AbsolutePath.make(tmp.path)])

          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("reviewer"), (agent) => {
              agent.permissions.push({ action: "skill", resource: "deploy", effect: "deny" })
            }),
          )

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "url", url: "https://example.test/skills/" }))

          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect(pulls).toBe(1)
          expect(SkillV2.available(yield* skill.list(), (yield* agents.get(AgentV2.ID.make("reviewer")))!)).toEqual([])
        }),
      ),
    ),
  )

  it.live("keeps a skill whose frontmatter has one wrong-typed value", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "review"), { recursive: true })
            // `slash` is a boolean, so `slash: "yes"` is a wrong-typed value rather than an
            // unknown key. The name and description are valid and must survive it.
            await fs.writeFile(
              path.join(tmp.path, "review", "SKILL.md"),
              `---\nname: review\ndescription: Reviews changes\nslash: "yes"\nnotakey: [1]\n---\n# review`,
            )
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) })
          })

          // Decoding the frontmatter as one block is all-or-nothing, so the quoted boolean used to
          // make the skill disappear entirely — name, description and body all lost, with no error
          // and no clue that one stray quote was the reason. Only `slash` may be dropped, and an
          // unknown key is still ignored rather than treated as a failure.
          expect(yield* skill.list()).toEqual([
            {
              name: "review",
              description: "Reviews changes",
              location: AbsolutePath.make(path.join(tmp.path, "review", "SKILL.md")),
              content: "# review",
            },
          ])
        }),
      ),
    ),
  )

  // A frontmatter that does not parse leaves nothing to recover, so the skill is dropped -- and it
  // used to be dropped in total silence, even though a file with a merely wrong-typed key reports
  // itself in the same loop. The more broken a file was, the quieter the loader got.
  it.live("reports a skill whose frontmatter does not parse, and still loads its siblings", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "broken"), { recursive: true })
            // An unterminated double quote is the shape `sanitize` cannot rescue, so it reaches the
            // parser as a genuine YAML failure.
            await fs.writeFile(path.join(tmp.path, "broken", "SKILL.md"), `---\nname: "unterminated\n---\n# broken`)
            await fs.mkdir(path.join(tmp.path, "good"), { recursive: true })
            await write(tmp.path, "good", "Still here")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) })
          })

          // One broken file must not cost the user the working ones.
          expect(yield* skill.list()).toEqual([
            {
              name: "good",
              description: "Still here",
              location: AbsolutePath.make(path.join(tmp.path, "good", "SKILL.md")),
              content: "# good",
            },
          ])

          // The warning must name the file. A skill's name comes from its frontmatter, which is
          // exactly what failed to parse, so the path is the only way to identify what was lost.
          // Read after `list()` on purpose: unlike the agent and command plugins, a skill directory
          // is only walked when a skill is actually listed, so the warning does not exist before then.
          const lines = yield* TestConsole.logLines
          const at = lines.indexOf("ignoring unparseable skill frontmatter")
          expect(at).toBeGreaterThan(0)
          expect(lines[at + 1]).toEqual({ path: path.join(tmp.path, "broken", "SKILL.md") })
        }),
      ),
    ),
  )
})
