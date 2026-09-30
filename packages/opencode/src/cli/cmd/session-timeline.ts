import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionTimeline } from "@/session/timeline"
import { NotFoundError } from "@/storage/storage"
import { UI } from "../ui"

const SEVERITY: Record<SessionTimeline.Finding["severity"], string> = {
  error: UI.Style.TEXT_DANGER_BOLD,
  warn: UI.Style.TEXT_WARNING_BOLD,
  info: UI.Style.TEXT_INFO_BOLD,
}

const GLYPH: Record<SessionTimeline.Finding["severity"], string> = { error: "✖", warn: "▲", info: "•" }

/** A bar that shows share without a unicode-block font, degrading to spaces. */
function bar(share: number, width: number): string {
  const filled = Math.round(share * width)
  return "█".repeat(Math.min(width, filled)) + "·".repeat(Math.max(0, width - filled))
}

export const SessionTimelineCommand = effectCmd({
  command: "timeline [sessionID]",
  aliases: ["tl"],
  describe: "what a session's context window is made of",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session to report on (default: the most recently updated session)",
        type: "string",
      })
      .option("limit", {
        alias: "n",
        describe: "how many of the largest parts to list",
        type: "number",
        default: 10,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.timeline")(function* (args) {
    // Which session to report on is a question about the caller, not about the
    // service: the report works on whatever session it is handed, so a client
    // can ask about any of them and not only the newest.
    const sessionID = args.sessionID
      ? SessionID.make(args.sessionID)
      : yield* Session.Service.use((svc) => svc.list({ limit: 1 })).pipe(
          Effect.map((sessions) => sessions[0]?.id),
          Effect.flatMap((id) => (id ? Effect.succeed(id) : Effect.succeed(undefined))),
        )

    if (!sessionID) return yield* fail("No sessions found in this project")

    const report = yield* SessionTimeline.Service.use((svc) =>
      svc.report({ sessionID, ...(args.limit ? { limit: args.limit } : {}) }),
    ).pipe(Effect.catchIf(NotFoundError.isInstance, (error) => fail(error.message)))

    if (args.format === "json") {
      process.stdout.write(JSON.stringify(report, null, 2) + EOL)
      return
    }

    const lines: string[] = []
    lines.push(`${UI.Style.TEXT_HIGHLIGHT_BOLD}${report.title}${UI.Style.TEXT_NORMAL}`)
    const s = report.shape
    lines.push(
      `${UI.Style.TEXT_DIM}${report.sessionID} · ${s.user} asked, ${s.assistant} answered · ` +
        `${s.tools} tool call${s.tools === 1 ? "" : "s"}${s.errors ? ` (${s.errors} failed)` : ""} · ` +
        `${s.subtasks} subagent${s.subtasks === 1 ? "" : "s"}${s.compactions ? ` · ${s.compactions} compaction${s.compactions === 1 ? "" : "s"}` : ""} · ` +
        `${(s.duration / 1000).toFixed(1)}s${UI.Style.TEXT_NORMAL}`,
    )
    lines.push("")

    if (report.shares.length === 0) {
      lines.push("This session has no content in it yet.")
    } else {
      lines.push(UI.Style.TEXT_DIM_BOLD + "context" + UI.Style.TEXT_NORMAL)
      for (const share of report.shares) {
        lines.push(
          `  ${bar(share.share, 24)} ` +
            `${(share.share * 100).toFixed(0).padStart(3)}%  ` +
            `${SessionTimeline.formatTokens(share.tokens).padStart(6)}  ` +
            `${SessionTimeline.describeBucket(share.bucket)}` +
            UI.Style.TEXT_DIM +
            ` (${share.parts} part${share.parts === 1 ? "" : "s"})` +
            UI.Style.TEXT_NORMAL,
        )
      }
    }

    if (report.contributors.length > 0) {
      lines.push("")
      lines.push(UI.Style.TEXT_DIM_BOLD + "largest parts" + UI.Style.TEXT_NORMAL)
      for (const item of report.contributors) {
        lines.push(
          `  ${SessionTimeline.formatTokens(item.tokens).padStart(6)}  ` +
            `${(item.share * 100).toFixed(0).padStart(3)}%  ` +
            `${item.label.padEnd(14)} ` +
            UI.Style.TEXT_DIM +
            `${item.partID} ${item.preview}`.trim() +
            UI.Style.TEXT_NORMAL,
        )
      }
    }

    // The estimate is only meaningful next to the number the provider reported,
    // and the gap between them is itself information: a breakdown that accounts
    // for 40% of the window is answering a different question than it appears to.
    lines.push("")
    if (report.coverage.measured > 0) {
      // The gap is only explained by the system prompt and tool definitions when
      // there is a gap. Saying it for a ratio near one would be an excuse for a
      // discrepancy that does not exist.
      const gap =
        report.coverage.ratio < 0.8
          ? UI.Style.TEXT_DIM + " (the rest is the system prompt and tool definitions)" + UI.Style.TEXT_NORMAL
          : ""
      lines.push(
        `estimated ${SessionTimeline.formatTokens(report.coverage.estimated)} tokens across these parts · ` +
          `last turn was sent ${SessionTimeline.formatTokens(report.coverage.measured)} · ` +
          `parts account for ${(report.coverage.ratio * 100).toFixed(0)}%` +
          gap,
      )
    } else {
      lines.push(
        `estimated ${SessionTimeline.formatTokens(report.coverage.estimated)} tokens across these parts` +
          UI.Style.TEXT_DIM +
          " · no turn has reported a token count to check this against" +
          UI.Style.TEXT_NORMAL,
      )
    }

    if (report.shape.toolsByName.length > 0) {
      lines.push("")
      lines.push(
        UI.Style.TEXT_DIM +
          "tools " +
          report.shape.toolsByName
            .map((tool) => `${tool.tool}×${tool.calls}${tool.errors ? ` (${tool.errors} failed)` : ""}`)
            .join(" · ") +
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
