import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { mkdir, writeFile } from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Command } from "@/command"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Command.node))

// The command table was a bare object literal. `Command.get` is reachable from
// `POST /session/:id/command` with an arbitrary name, and command names also
// come from config keys and SKILL.md frontmatter. `commands["constructor"]`
// returned the `Object` function, which is truthy, so the caller's
// "Command not found" guard was skipped and it then crashed on
// `cmd.template.match(...)` instead of reporting an unknown command.
const PROTOTYPE_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "__defineGetter__"]

const resolveTemplate = (info: Command.Info | undefined) =>
  Effect.suspend(() => {
    const value = info?.template
    return typeof value === "string" ? Effect.succeed(value) : Effect.promise(() => value ?? Promise.resolve(""))
  })

const writeUserCommand = (directory: string, name: string, contents: string) =>
  Effect.promise(async () => {
    const dir = path.join(directory, ".opencode", "command")
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${name}.md`), contents)
  })

describe("command names that collide with Object.prototype", () => {
  for (const name of PROTOTYPE_KEYS) {
    it.instance(`${name} is reported as unknown, not resolved to an inherited member`, () =>
      Effect.gen(function* () {
        const command = yield* Command.Service
        // The session command handler relies on this returning undefined so it
        // can raise "Command not found" with the list of real names.
        expect(yield* command.get(name)).toBeUndefined()
        const listed = (yield* command.list()).map((c) => c.name)
        expect(listed).not.toContain(name)
      }),
    )
  }

  for (const name of PROTOTYPE_KEYS) {
    it.instance(
      `${name}.md registers as a real command`,
      () =>
        Effect.gen(function* () {
          const command = yield* Command.Service
          const found = yield* command.get(name)
          expect(found).toBeDefined()
          expect(found?.name).toBe(name)
          expect(found?.source).toBe("command")
          // The handler reads the template and calls .match() on it.
          const template = yield* resolveTemplate(found)
          expect(typeof template).toBe("string")
          expect(template).toContain("hello")
        }),
      { init: (dir) => writeUserCommand(dir, name, `hello from ${name} $ARGUMENTS`) },
    )
  }
})
