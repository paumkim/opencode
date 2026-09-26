import type { SlashCommand } from "./slash-popover"

// Mirrors `Command.Default` in packages/opencode/src/command/index.ts. The server reports native
// builtins with `source: "command"`, the same value it uses for user authored command files, so
// the client keeps its own list of the names the server treats as native.
export const NATIVE_COMMANDS = ["goal", "init", "review"] as const

export function isNativeCommand(name: string) {
  return (NATIVE_COMMANDS as readonly string[]).includes(name)
}

type ServerCommand = { name: string; description?: string; source?: "command" | "mcp" | "skill" }

/**
 * Combines the server command list with the client registered builtins. Native commands are
 * grouped with the builtins, everything the server reports as a user/MCP/skill command stays in
 * the custom group. A native command that is also registered client side is dropped so the same
 * trigger never renders twice.
 */
export function mergeSlashCommands(commands: ServerCommand[], builtin: SlashCommand[]): SlashCommand[] {
  const native: SlashCommand[] = []
  const custom: SlashCommand[] = []

  for (const command of commands) {
    const entry: SlashCommand = {
      id: `custom.${command.name}`,
      trigger: command.name,
      title: command.name,
      description: command.description,
      source: command.source,
      type: isNativeCommand(command.name) ? "builtin" : "custom",
    }
    if (entry.type === "builtin") {
      entry.native = true
      native.push(entry)
      continue
    }
    custom.push(entry)
  }

  const registered = new Set(builtin.map((item) => item.trigger))
  return [...custom, ...builtin, ...native.filter((item) => !registered.has(item.trigger))]
}

/**
 * Commands that put their trigger in the prompt instead of dispatching a client side handler.
 * Client builtins run an action right away, both native and user commands are sent on submit.
 */
export function isPromptCommand(command: SlashCommand) {
  return command.type === "custom" || command.native === true
}
