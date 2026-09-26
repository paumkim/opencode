import { describe, expect, test } from "bun:test"
import { showSlashCommandBadge, type SlashCommand } from "./slash-popover"
import { isNativeCommand, isPromptCommand, mergeSlashCommands, NATIVE_COMMANDS } from "./slash-commands"

const clientBuiltin: SlashCommand = {
  id: "session.compact",
  trigger: "compact",
  title: "Compact",
  type: "builtin",
}

const server = [
  { name: "goal", description: "Set or view the long-running session goal" },
  { name: "init", description: "guided AGENTS.md setup" },
  { name: "review", description: "review changes" },
  { name: "deploy", description: "ship it" },
  { name: "helper", description: "user command file" },
]

describe("isNativeCommand", () => {
  test("covers every server native command", () => {
    expect([...NATIVE_COMMANDS]).toEqual(["goal", "init", "review"])
    for (const name of NATIVE_COMMANDS) expect(isNativeCommand(name)).toBe(true)
    expect(isNativeCommand("deploy")).toBe(false)
  })
})

describe("mergeSlashCommands", () => {
  test("groups native server commands with the builtins", () => {
    const merged = mergeSlashCommands(server, [clientBuiltin])

    expect(merged.map((item) => [item.trigger, item.type])).toEqual([
      ["deploy", "custom"],
      ["helper", "custom"],
      ["compact", "builtin"],
      ["goal", "builtin"],
      ["init", "builtin"],
      ["review", "builtin"],
    ])
    expect(merged.find((item) => item.trigger === "goal")).toEqual({
      id: "custom.goal",
      trigger: "goal",
      title: "goal",
      description: "Set or view the long-running session goal",
      type: "builtin",
      native: true,
    })
  })

  test("keeps user authored commands in the custom group", () => {
    const merged = mergeSlashCommands([{ name: "helper", description: "user command file" }], [clientBuiltin])

    expect(merged).toEqual([
      {
        id: "custom.helper",
        trigger: "helper",
        title: "helper",
        description: "user command file",
        type: "custom",
      },
      clientBuiltin,
    ])
  })

  test("does not render a native command twice when it is also registered client side", () => {
    const registered: SlashCommand = { id: "command.goal", trigger: "goal", title: "Goal", type: "builtin" }
    const merged = mergeSlashCommands([{ name: "goal" }], [registered])

    expect(merged).toEqual([registered])
  })

  test("keeps a custom command that shadows a client builtin trigger", () => {
    const merged = mergeSlashCommands([{ name: "compact" }], [clientBuiltin])

    expect(merged.map((item) => item.id)).toEqual(["custom.compact", "session.compact"])
  })
})

describe("slash command badges", () => {
  test("hides the badge for native commands", () => {
    const [native] = mergeSlashCommands([{ name: "goal" }], [])
    expect(showSlashCommandBadge(native)).toBe(false)
  })

  test("shows the badge for user, mcp and skill commands", () => {
    const [user] = mergeSlashCommands([{ name: "helper" }], [])
    expect(showSlashCommandBadge(user)).toBe(true)
    expect(showSlashCommandBadge({ ...user, source: "mcp" })).toBe(true)
    expect(showSlashCommandBadge({ ...user, source: "skill" })).toBe(true)
    expect(showSlashCommandBadge({ ...user, source: "command" })).toBe(false)
  })
})

describe("isPromptCommand", () => {
  test("sends native and custom commands through the prompt", () => {
    const [native, custom] = mergeSlashCommands([{ name: "goal" }, { name: "helper" }], [])

    expect(isPromptCommand(native)).toBe(true)
    expect(isPromptCommand(custom)).toBe(true)
  })

  test("dispatches client builtins directly", () => {
    expect(isPromptCommand(clientBuiltin)).toBe(false)
  })
})
