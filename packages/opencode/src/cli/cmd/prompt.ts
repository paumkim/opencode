import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { PromptShowCommand } from "./prompt-show"

/**
 * Reports on the prompt itself, as opposed to the conversation it starts.
 *
 * A group rather than a top-level command so that the parts of a prompt — the
 * base prompt, the instructions, the tool definitions — can each grow their own
 * reporting later without renaming what is already here.
 */
export const PromptCommand = cmd({
  command: "prompt",
  describe: "inspect the prompt opencode sends",
  builder: (yargs: Argv) => yargs.command(PromptShowCommand).demandCommand(),
  async handler() {},
})
