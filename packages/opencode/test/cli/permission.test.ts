import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import { PermissionExplainCommand } from "../../src/cli/cmd/permission"

// yargs only runs a subcommand's builder once its own name is in argv.
const parse = (argv: string[]) =>
  yargs([])
    .command({ ...PermissionExplainCommand, handler: () => {} })
    .exitProcess(false)
    .parse(["explain", ...argv])

describe("permission explain command", () => {
  test("asks about one permission with no pattern, which means anything", async () => {
    const args = await parse(["bash"])
    expect(args.permission).toBe("bash")
    expect(args.pattern).toEqual([])
  })

  test("takes a command with flags in it as the pattern, not as flags", async () => {
    // The natural way to ask this question is about a shell command, so
    // `rm -rf /` has to arrive as the pattern rather than as `-r -f /`.
    const args = await parse(["bash", "rm -rf /"])
    expect(args.pattern).toEqual(["rm -rf /"])
  })

  test("keeps options after the pattern", async () => {
    const args = await parse(["bash", "rm -rf /", "--agent", "reviewer", "--format", "json"])
    expect(args.permission).toBe("bash")
    expect(args.pattern).toEqual(["rm -rf /"])
    expect(args.agent).toBe("reviewer")
    expect(args.format).toBe("json")
  })

  test("defaults to the session's agent and to the covering rules only", async () => {
    const args = await parse(["edit"])
    expect(args.agent).toBeUndefined()
    expect(args.session).toBeUndefined()
    expect(args.all).toBe(false)
    expect(args.format).toBe("text")
  })

  test("can name the agent and the session whose rules stack on top", async () => {
    const args = await parse(["edit", "src/a.ts", "--agent", "reviewer", "--session", "ses_abc"])
    expect(args.agent).toBe("reviewer")
    expect(args.session).toBe("ses_abc")
    expect(args.pattern).toEqual(["src/a.ts"])
  })

  test("asks for the whole ruleset with --all", async () => {
    expect((await parse(["bash", "--all"])).all).toBe(true)
  })
})
