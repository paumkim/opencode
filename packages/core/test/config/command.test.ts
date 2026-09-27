import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { CommandV2 } from "@opencode-ai/core/command"
import { Config } from "@opencode-ai/core/config"
import { ConfigCommandPlugin } from "@opencode-ai/core/config/plugin/command"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([CommandV2.node, FSUtil.node])))
const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigCommandPlugin.Plugin", () => {
  it.live("loads inline and file-based commands in config order", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "commands", "nested"), { recursive: true })
            await fs.writeFile(
              path.join(tmp.path, "commands", "review.md"),
              `---
description: File review
agent: reviewer
model: anthropic/claude
variant: high
subtask: true
---
Review files`,
            )
            await fs.writeFile(path.join(tmp.path, "commands", "nested", "docs.md"), "Write docs")
            await fs.writeFile(path.join(tmp.path, "commands", "empty.md"), "")
          })

          const command = yield* CommandV2.Service
          yield* ConfigCommandPlugin.Plugin.effect(host({ command: { ...command, reload: command.reload } })).pipe(
            Effect.provideService(
              Config.Service,
              Config.Service.of({
                entries: () =>
                  Effect.succeed([
                    new Config.Document({
                      type: "document",
                      info: decode({ commands: { review: { template: "Inline review" } } }),
                    }),
                    new Config.Directory({ type: "directory", path: AbsolutePath.make(tmp.path) }),
                  ]),
              }),
            ),
          )

          expect(yield* command.list()).toEqual([
            CommandV2.Info.make({
              name: "review",
              template: "Review files",
              description: "File review",
              agent: "reviewer",
              model: {
                providerID: ProviderV2.ID.make("anthropic"),
                id: ModelV2.ID.make("claude"),
                variant: ModelV2.VariantID.make("high"),
              },
              subtask: true,
            }),
            CommandV2.Info.make({ name: "empty", template: "" }),
            CommandV2.Info.make({ name: "nested/docs", template: "Write docs" }),
          ])
        }),
      ),
    ),
  )

  it.live("still loads a command whose frontmatter has one wrong-typed value", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "commands"), { recursive: true })
            // `subtask` is a boolean. A quoted "yes" fails the whole struct, which used to make
            // the command disappear from the list entirely — the reader saw a missing command and
            // no indication that a single character of quoting was the reason.
            await fs.writeFile(
              path.join(tmp.path, "commands", "review.md"),
              `---
description: File review
subtask: "yes"
---
Review files`,
            )
          })

          const command = yield* CommandV2.Service
          yield* ConfigCommandPlugin.Plugin.effect(host({ command: { ...command, reload: command.reload } })).pipe(
            Effect.provideService(
              Config.Service,
              Config.Service.of({
                entries: () =>
                  Effect.succeed([new Config.Directory({ type: "directory", path: AbsolutePath.make(tmp.path) })]),
              }),
            ),
          )

          expect(yield* command.list()).toEqual([
            CommandV2.Info.make({ name: "review", template: "Review files", description: "File review" }),
          ])
        }),
      ),
    ),
  )

  // A file whose frontmatter does not parse cannot be partially recovered -- there are no keys to
  // keep -- so it is dropped. It used to be dropped in total silence, even though a file with a
  // merely wrong-typed key reports itself two lines up in the same function. The more broken a file
  // was, the quieter this loader got.
  it.live("reports a command file whose frontmatter does not parse, and still loads its siblings", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "commands"), { recursive: true })
            // An unterminated double quote is the shape `sanitize` cannot rescue, so it reaches the
            // parser as a genuine YAML failure.
            await fs.writeFile(
              path.join(tmp.path, "commands", "broken.md"),
              `---\ndescription: "unterminated\n---\nBroken body`,
            )
            await fs.writeFile(
              path.join(tmp.path, "commands", "good.md"),
              `---
description: Still here
---
Good body`,
            )
          })

          const command = yield* CommandV2.Service
          yield* ConfigCommandPlugin.Plugin.effect(host({ command: { ...command, reload: command.reload } })).pipe(
            Effect.provideService(
              Config.Service,
              Config.Service.of({
                entries: () =>
                  Effect.succeed([new Config.Directory({ type: "directory", path: AbsolutePath.make(tmp.path) })]),
              }),
            ),
          )

          // The warning must name the file: a bare "something was ignored" is not actionable, and the
          // file is the only thing that identifies which command is missing.
          // `TestConsole.logLines` is a flat capture -- prefix, message, then the annotations object
          // for each logged call, not one tuple per call -- so the message and its annotations are
          // consecutive entries and are located by searching for the message.
          const lines = yield* TestConsole.logLines
          const at = lines.indexOf("ignoring unparseable command frontmatter")
          expect(at).toBeGreaterThan(0)
          expect(lines[at + 1]).toEqual({ path: path.join(tmp.path, "commands", "broken.md") })

          // One broken file must not cost the user the working ones.
          expect(yield* command.list()).toEqual([
            CommandV2.Info.make({ name: "good", template: "Good body", description: "Still here" }),
          ])
        }),
      ),
    ),
  )
})
