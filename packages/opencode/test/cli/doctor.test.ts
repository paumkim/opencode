import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import { DoctorCommand } from "../../src/cli/cmd/doctor"

// yargs only runs a command's builder once the command name is in argv.
const parse = (argv: string[]) =>
  yargs([])
    .command({ ...DoctorCommand, handler: () => {} })
    .exitProcess(false)
    .parse(["doctor", ...argv])

describe("doctor command", () => {
  test("defaults to a full text report that includes the MCP check", async () => {
    const args = await parse([])
    expect(args.json).toBe(false)
    expect(args.brief).toBe(false)
    expect(args.mcp).toBe(true)
  })

  test("accepts the machine-readable and brief flags", async () => {
    const args = await parse(["--json", "--brief"])
    expect(args.json).toBe(true)
    expect(args.brief).toBe(true)
  })

  test("honours --no-mcp so the report never opens a server connection", async () => {
    expect((await parse(["--no-mcp"])).mcp).toBe(false)
  })
})
