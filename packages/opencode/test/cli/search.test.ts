import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import { SearchCommand } from "../../src/cli/cmd/search"

// yargs only runs a command's builder once the command name is in argv.
const parse = (argv: string[]) =>
  yargs([])
    .command({ ...SearchCommand, handler: () => {} })
    .exitProcess(false)
    .parse(["search", ...argv])

describe("search command", () => {
  test("collects the whole command line as one query", async () => {
    // A search command is useless if the user has to quote the phrase.
    const args = await parse(["rotate", "the", "database", "password"])
    expect(args.query).toEqual(["rotate", "the", "database", "password"])
  })

  test("defaults to a scoped, case-insensitive, human-readable search", async () => {
    const args = await parse(["x"])
    expect(args.session).toBeUndefined()
    expect(args.all).toBe(false)
    expect(args.case).toBe(false)
    expect(args.synthetic).toBe(false)
    expect(args.limit).toBeUndefined()
    expect(args.format).toBe("text")
  })

  test("accepts every narrowing flag before the query", async () => {
    const args = await parse([
      "--session",
      "ses_abc",
      "--all",
      "--case",
      "--synthetic",
      "--limit",
      "5",
      "--format",
      "json",
      "needle",
    ])
    expect(args.query).toEqual(["needle"])
    expect(args.session).toBe("ses_abc")
    expect(args.all).toBe(true)
    expect(args.case).toBe(true)
    expect(args.synthetic).toBe(true)
    expect(args.limit).toBe(5)
    expect(args.format).toBe("json")
  })

  test("limits output to the two declared formats", async () => {
    expect((await parse(["--format", "json", "x"])).format).toBe("json")
    expect((await parse(["--format", "text", "x"])).format).toBe("text")
  })
})
