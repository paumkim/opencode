import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionSecrets } from "@/session/secrets"
import { NotFoundError } from "@/storage/storage"
import { UI } from "../ui"

const KIND_COLOR: Record<SessionSecrets.Kind, string> = {
  "private-key": UI.Style.TEXT_DANGER_BOLD,
  "aws-access-key": UI.Style.TEXT_DANGER_BOLD,
  "anthropic-key": UI.Style.TEXT_DANGER_BOLD,
  "openai-key": UI.Style.TEXT_DANGER_BOLD,
  "github-token": UI.Style.TEXT_DANGER_BOLD,
  "slack-token": UI.Style.TEXT_DANGER_BOLD,
  "google-api-key": UI.Style.TEXT_DANGER_BOLD,
  jwt: UI.Style.TEXT_WARNING_BOLD,
  "url-credentials": UI.Style.TEXT_WARNING_BOLD,
  "assigned-secret": UI.Style.TEXT_WARNING_BOLD,
}

export const SessionSecretsCommand = effectCmd({
  command: "secrets [sessionID]",
  describe: "scan a session for credentials that ended up in its transcript",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session to scan (default: the most recently updated session)",
        type: "string",
      })
      .option("redact", {
        describe: "print the transcript with every finding replaced",
        type: "boolean",
        default: false,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["text", "json"],
        default: "text",
      }),
  handler: Effect.fn("Cli.session.secrets")(function* (args) {
    const sessionID = args.sessionID
      ? SessionID.make(args.sessionID)
      : yield* Session.Service.use((svc) => svc.list({ limit: 1 })).pipe(Effect.map((sessions) => sessions[0]?.id))
    if (!sessionID) return yield* fail("No sessions found in this project")

    const report = yield* SessionSecrets.Service.use((svc) =>
      svc.scan({ sessionID, ...(args.redact ? { redacted: true } : {}) }),
    ).pipe(Effect.catchIf(NotFoundError.isInstance, (error) => fail(error.message)))

    if (args.format === "json") {
      process.stdout.write(JSON.stringify(report, null, 2) + EOL)
      return
    }

    if (report.findings.length === 0) {
      process.stdout.write(
        UI.Style.TEXT_SUCCESS + `No credential-shaped strings in ${report.title}.` + UI.Style.TEXT_NORMAL + EOL,
      )
      return
    }

    const lines: string[] = []
    lines.push(
      `${UI.Style.TEXT_DANGER_BOLD}${report.findings.length} credential-shaped string${
        report.findings.length === 1 ? "" : "s"
      } in ${report.title}${UI.Style.TEXT_NORMAL}`,
    )
    lines.push(
      UI.Style.TEXT_DIM +
        "This transcript is stored and re-sent to the provider on every later turn." +
        UI.Style.TEXT_NORMAL,
    )
    for (const finding of report.findings) {
      lines.push("")
      lines.push(
        `  ${KIND_COLOR[finding.kind]}${finding.kind}${UI.Style.TEXT_NORMAL}` +
          (finding.subject ? UI.Style.TEXT_DIM + ` (${finding.subject})` + UI.Style.TEXT_NORMAL : "") +
          UI.Style.TEXT_DIM +
          ` in ${finding.role} output from ${finding.source}` +
          UI.Style.TEXT_NORMAL,
      )
    }
    lines.push("")
    lines.push(
      UI.Style.TEXT_DIM +
        "Rotate anything real, then re-run with --redact to see a shareable transcript." +
        UI.Style.TEXT_NORMAL,
    )

    if (report.redacted !== undefined) {
      lines.push("")
      lines.push(UI.Style.TEXT_DIM_BOLD + "--- redacted transcript ---" + UI.Style.TEXT_NORMAL)
      lines.push(report.redacted)
    }

    process.stdout.write(lines.join(EOL) + EOL)
  }),
})
