import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import { SessionTimelineCommand } from "../../src/cli/cmd/session-timeline"

// yargs only runs a subcommand's builder once its own name is in argv, and
// this command is registered under `timeline`.
const parse = (argv: string[]) =>
  yargs([])
    .command({ ...SessionTimelineCommand, handler: () => {} })
    .exitProcess(false)
    .parse(["timeline", ...argv])

describe("session timeline command", () => {
  test("reports on whatever session it is given", async () => {
    expect((await parse(["ses_abc"])).sessionID).toBe("ses_abc")
  })

  test("leaves the session open so the newest one in the project is used", async () => {
    expect((await parse([])).sessionID).toBeUndefined()
  })

  test("lists ten parts by default, because ten is readable and twenty is not", async () => {
    expect((await parse([])).limit).toBe(10)
  })

  test("accepts a part window and a machine-readable format", async () => {
    const args = await parse(["--limit", "3", "--format", "json", "ses_abc"])
    expect(args.limit).toBe(3)
    expect(args.format).toBe("json")
  })

  test("keeps -n as the short form of --limit", async () => {
    expect((await parse(["-n", "5"])).limit).toBe(5)
  })

  test("is reachable as tl, because the word is long and this is one of several session reports", async () => {
    const args = await yargs([])
      .command({ ...SessionTimelineCommand, handler: () => {} })
      .exitProcess(false)
      .parse(["tl", "ses_abc"])
    expect((args._ as string[])[0]).toBe("tl")
    expect(args.sessionID).toBe("ses_abc")
  })
})
