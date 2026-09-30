import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import { PromptShowCommand } from "../../src/cli/cmd/prompt-show"

// the subcommand is registered directly here because that is what
// yargs runs its builder against; the `prompt` group around it is a separate
// concern and has its own snapshot test.
// The subcommand's own handler is stubbed as well as the group's: stubbing only
// the group would let `show` run for real, resolving an agent and a model from
// this machine, which is a different test than the one being written here.
const parse = (argv: string[]) =>
  yargs([])
    .command({ ...PromptShowCommand, handler: () => {} })
    .exitProcess(false)
    .parse(["show", ...argv])

describe("prompt show command", () => {
  test("reports on whatever agent it is given", async () => {
    expect((await parse(["reviewer"])).agent).toBe("reviewer")
  })

  test("leaves the agent open so the project's default is used", async () => {
    expect((await parse([])).agent).toBeUndefined()
  })

  test("accepts a model override, because the base prompt depends on it", async () => {
    // The built-in prompt is chosen from the model, so measuring without the
    // right one would describe a prompt that is never sent.
    expect((await parse(["-m", "claude-sonnet-4-5"])).model).toBe("claude-sonnet-4-5")
    expect((await parse(["--model", "gpt-5"])).model).toBe("gpt-5")
  })

  test("lists a readable number of tools by default", async () => {
    expect((await parse([])).limit).toBe(12)
  })

  test("accepts a tool window and a machine-readable format", async () => {
    const args = await parse(["-n", "3", "--format", "json"])
    expect(args.limit).toBe(3)
    expect(args.format).toBe("json")
  })

  test("keeps -n as the short form of --limit", async () => {
    expect((await parse(["-n", "1"])).limit).toBe(1)
  })
})
