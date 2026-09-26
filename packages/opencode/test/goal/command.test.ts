import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { mkdir, writeFile } from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Command } from "@/command"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Command.node))

const CONTRACT_STRINGS = [
  "<goal_command_arguments>",
  "$ARGUMENTS",
  '"history"',
  '"pause"',
  '"resume"',
  '"clear"',
  '"edit "',
  '"status"',
  '"show"',
  '"current"',
  '"complete "',
  '"done "',
  '"unmet "',
  '"blocked "',
  'start with "extend "',
  "extend_goal",
  "Pass null for every limit the user did not name",
  "A limited goal must be extended first; do not claim resume bypasses a limit.",
  "token_budget: null",
  "max_auto_turns: null",
  "max_duration_seconds: null",
  "Only pass a number for a limit the user actually asked for",
  "Create a goal only from these explicit command arguments.",
  "After create_goal succeeds, continue working toward the new goal.",
]

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

describe("native /goal command", () => {
  it.instance("is registered as a native command with the documented description", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const goal = yield* command.get(Command.Default.GOAL)

      expect(goal).toBeDefined()
      expect(goal?.name).toBe("goal")
      expect(goal?.description).toBe("Set or view the long-running session goal")
      // `source` is what tells consumers this is a builtin rather than a plugin/user command.
      expect(goal?.source).toBe("command")
      expect(goal?.subtask).toBeUndefined()
    }),
  )

  it.instance("ships the goal template with the full argument contract", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const template = yield* resolveTemplate(yield* command.get(Command.Default.GOAL))

      expect(template).toContain('OpenCode goal mode command "/goal" was invoked')
      for (const text of CONTRACT_STRINGS) expect(template).toContain(text)
    }),
  )

  it.instance("orders the prefix branches before the catch-all create branch", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const template = yield* resolveTemplate(yield* command.get(Command.Default.GOAL))

      const fallback = template.indexOf("Otherwise, create a new goal")
      expect(fallback).toBeGreaterThan(-1)
      // If the catch-all came first, "extend ..." would be swallowed as an objective.
      for (const prefix of ['start with "extend "', 'start with "edit "', 'start with "complete "', 'start with "unmet "']) {
        const index = template.indexOf(prefix)
        expect(index).toBeGreaterThan(-1)
        expect(index).toBeLessThan(fallback)
      }
    }),
  )

  it.instance("computes $ARGUMENTS hints from the native template", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const goal = yield* command.get(Command.Default.GOAL)
      const template = yield* resolveTemplate(goal)

      // The native template only interpolates $ARGUMENTS, so that is the only hint.
      expect(goal?.hints).toEqual(["$ARGUMENTS"])
      expect(goal?.hints).toEqual(Command.hints(template))
    }),
  )

  it.instance("is listed alongside the other native builtins", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const names = (yield* command.list()).map((item) => item.name)

      expect(names).toContain("goal")
      expect(names).toContain("init")
      expect(names).toContain("review")
    }),
  )

  it.instance("registers no separate pause_goal or resume_goal commands", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service

      // opencode routes everything through /goal; there are no separate pause_goal /
      // resume_goal commands here (unlike the sibling term plugin).
      expect(yield* command.get("pause_goal")).toBeUndefined()
      expect(yield* command.get("resume_goal")).toBeUndefined()
    }),
  )

})

describe("native /goal command precedence", () => {
  it.instance(
    "a user-authored command/goal.md replaces the native default",
    () =>
      Effect.gen(function* () {
        const command = yield* Command.Service
        const goal = yield* command.get(Command.Default.GOAL)

        // cfg.command is merged after the builtin assignments, so a user file wins.
        expect(goal?.description).toBe("user supplied goal")
        expect(yield* resolveTemplate(goal)).toBe("user authored /goal\n\n$ARGUMENTS")
        expect(yield* resolveTemplate(goal)).not.toContain("OpenCode goal mode command")
        expect(goal?.hints).toEqual(["$ARGUMENTS"])
      }),
    {
      init: (directory) =>
        writeUserCommand(directory, "goal", "---\ndescription: user supplied goal\n---\n\nuser authored /goal\n\n$ARGUMENTS"),
    },
  )
})
