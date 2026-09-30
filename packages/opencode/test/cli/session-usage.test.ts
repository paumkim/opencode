import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import { SessionUsageCommand } from "../../src/cli/cmd/session-usage"

// yargs only runs a subcommand's builder once its own name is in argv, and
// this command is registered under `usage`.
const parse = (argv: string[]) =>
  yargs([])
    .command({ ...SessionUsageCommand, handler: () => {} })
    .exitProcess(false)
    .parse(["usage", ...argv])

describe("session usage command", () => {
  test("reports on whatever session it is given", async () => {
    const args = await parse(["ses_abc"])
    expect(args.sessionID).toBe("ses_abc")
  })

  test("leaves the session open so the newest one in the project is used", async () => {
    expect((await parse([])).sessionID).toBeUndefined()
  })

  test("defaults to a full human-readable report", async () => {
    const args = await parse([])
    expect(args.limit).toBeUndefined()
    expect(args.format).toBe("table")
  })

  test("accepts a turn window and a machine-readable format", async () => {
    const args = await parse(["--limit", "20", "--format", "json", "ses_abc"])
    expect(args.limit).toBe(20)
    expect(args.format).toBe("json")
  })

  test("keeps -n as the short form of --limit", async () => {
    expect((await parse(["-n", "5"])).limit).toBe(5)
  })
})
