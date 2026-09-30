import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionUsage, type Turn } from "@/session/usage"
import { NotFoundError } from "@/storage/storage"
import { UI } from "../ui"

const SEVERITY: Record<SessionUsage.Finding["severity"], string> = {
  error: UI.Style.TEXT_DANGER_BOLD,
  warn: UI.Style.TEXT_WARNING_BOLD,
  info: UI.Style.TEXT_INFO_BOLD,
}

const GLYPH: Record<SessionUsage.Finding["severity"], string> = { error: "✖", warn: "▲", info: "•" }

/**
 * The most recent turn, or the session's only one. Shown next to each row so a
 * long conversation can be read without counting back from the end.
 */
function turnLabel(turn: Turn, index: number, total: number): string {
  const position = `#${index + 1}/${total}`
  return position
}

export const SessionUsageCommand = effectCmd({
  command: "usage [sessionID]",
  describe: "break a session's cost and tokens down by turn",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session to report on (default: the most recently updated session)",
        type: "string",
      })
      .option("limit", {
        alias: "n",
        describe: "only report the most recent N turns",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.usage")(function* (args) {
    // Resolving the default here rather than in the service keeps "which
    // session" a question about the caller: the service reports on the session
    // it is handed, so the TUI can ask about any session, not just the newest.
    const sessionID = args.sessionID
      ? SessionID.make(args.sessionID)
      : yield* Session.Service.use((svc) => svc.list({ limit: 1 })).pipe(
          Effect.map((sessions) => sessions[0]?.id),
          Effect.flatMap((id) => (id ? Effect.succeed(id) : Effect.succeed(undefined))),
        )

    if (!sessionID) return yield* fail("No sessions found in this project")

    const report = yield* SessionUsage.Service.use((svc) =>
      svc.report({ sessionID, ...(args.limit ? { limit: args.limit } : {}) }),
    ).pipe(Effect.catchIf(NotFoundError.isInstance, (error) => fail(error.message)))

    if (args.format === "json") {
      process.stdout.write(JSON.stringify(report, null, 2) + EOL)
      return
    }

    const lines: string[] = []
    lines.push(`${UI.Style.TEXT_HIGHLIGHT_BOLD}${report.title}${UI.Style.TEXT_NORMAL}`)
    lines.push(
      `${UI.Style.TEXT_DIM}${report.sessionID} · ${report.totals.turns} turn${report.totals.turns === 1 ? "" : "s"}${UI.Style.TEXT_NORMAL}`,
    )
    lines.push("")

    if (report.turns.length === 0) {
      lines.push("No assistant turns recorded for this session yet.")
    } else {
      const headers = ["turn", "model", "in", "out", "think", "cache", "cost"]
      const rows = report.turns.map((turn, index) => [
        turnLabel(turn, index, report.turns.length),
        `${turn.providerID}/${turn.modelID}`,
        SessionUsage.formatTokens(turn.input),
        SessionUsage.formatTokens(turn.output),
        SessionUsage.formatTokens(turn.reasoning),
        SessionUsage.formatTokens(turn.cacheRead),
        SessionUsage.formatCost(turn.cost, report.totals),
      ])
      const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column].length)))
      lines.push(UI.Style.TEXT_DIM_BOLD + headers.map((h, i) => h.padEnd(widths[i])).join("  ") + UI.Style.TEXT_NORMAL)
      for (const row of rows)
        lines.push(
          row
            .map((cell, i) => cell.padEnd(widths[i]))
            .join("  ")
            .trimEnd(),
        )
    }

    lines.push("")
    const t = report.totals
    lines.push(
      `total ${SessionUsage.formatTokens(t.input + t.cacheRead)} in · ` +
        `${SessionUsage.formatTokens(t.output)} out · ` +
        `${SessionUsage.formatTokens(t.reasoning)} reasoning · ` +
        `cache ${(t.cacheHitRate * 100).toFixed(0)}% · ` +
        `peak context ${SessionUsage.formatTokens(t.peakInput)} · ` +
        SessionUsage.formatCost(t.cost, t),
    )
    if (report.sessionCost !== t.cost) {
      lines.push(
        UI.Style.TEXT_DIM +
          `session total ${SessionUsage.formatCost(report.sessionCost, t)} across ${SessionUsage.formatTokens(report.sessionTokens)} tokens` +
          UI.Style.TEXT_NORMAL,
      )
    }

    for (const finding of report.findings) {
      lines.push("")
      lines.push(`${SEVERITY[finding.severity]}${GLYPH[finding.severity]} ${finding.title}${UI.Style.TEXT_NORMAL}`)
      if (finding.detail) lines.push(UI.Style.TEXT_DIM + "    " + finding.detail + UI.Style.TEXT_NORMAL)
      if (finding.hint) lines.push("    " + UI.Style.TEXT_INFO + finding.hint + UI.Style.TEXT_NORMAL)
    }

    process.stdout.write(lines.join(EOL).trimEnd() + EOL)
  }),
})
