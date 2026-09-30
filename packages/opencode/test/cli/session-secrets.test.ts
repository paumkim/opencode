import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import { SessionSecretsCommand } from "../../src/cli/cmd/session-secrets"

// yargs only runs a subcommand's builder once its own name is in argv.
const parse = (argv: string[]) =>
  yargs([])
    .command({ ...SessionSecretsCommand, handler: () => {} })
    .exitProcess(false)
    .parse(["secrets", ...argv])

describe("session secrets command", () => {
  test("leaves the session open so the newest one is scanned", async () => {
    const args = await parse([])
    expect(args.sessionID).toBeUndefined()
    expect(args.redact).toBe(false)
    expect(args.format).toBe("text")
  })

  test("scans the session it is given", async () => {
    expect((await parse(["ses_abc"])).sessionID).toBe("ses_abc")
  })

  test("asks for the redacted transcript only when told to", async () => {
    // The transcript is a page of everything the session contains, so it is
    // never the default output of a command whose job is to find secrets.
    expect((await parse(["ses_abc"])).redact).toBe(false)
    expect((await parse(["ses_abc", "--redact"])).redact).toBe(true)
  })

  test("emits JSON for a machine-readable report", async () => {
    expect((await parse(["ses_abc", "--format", "json"])).format).toBe("json")
  })
})
