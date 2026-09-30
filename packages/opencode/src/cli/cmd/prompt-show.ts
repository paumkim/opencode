import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionPromptSize } from "@/session/prompt-size"
import { UI } from "../ui"

const SEVERITY: Record<SessionPromptSize.Finding["severity"], string> = {
  warn: UI.Style.TEXT_WARNING_BOLD,
  info: UI.Style.TEXT_INFO_BOLD,
}

const GLYPH: Record<SessionPromptSize.Finding["severity"], string> = { warn: "▲", info: "•" }

const bar = (share: number, width: number) => {
  const filled = Math.round(share * width)
  return "█".repeat(Math.min(width, filled)) + "·".repeat(Math.max(0, width - filled))
}

export const PromptShowCommand = effectCmd({
  command: "show [agent]",
  describe: "show what the harness will send as the system prompt, sized",
  builder: (yargs) =>
    yargs
      .positional("agent", {
        describe: "agent to report on (default: the project's default agent)",
        type: "string",
      })
      .option("model", {
        alias: "m",
        describe: "model to report for (default: the agent's default model)",
        type: "string",
      })
      .option("limit", {
        alias: "n",
        describe: "how many of the largest tool definitions to list",
        type: "number",
        default: 12,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.prompt.show")(function* (args) {
    // The agent and model are resolved here rather than inside the service, so
    // "which agent" stays a question about the caller and the service stays
    // testable against a hand-built agent.
    const agentName = args.agent ?? (yield* Agent.Service.use((svc) => svc.defaultAgent()).pipe(Effect.orDie))
    // `get` fails in the error channel for a name that does not resolve, and a
    // name the user typed is exactly the case worth turning into a message
    // rather than a stack.
    const agent = yield* Agent.Service.use((svc) => svc.get(agentName)).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    if (!agent) return yield* fail(`Agent not found: ${agentName}`)

    // The same resolution a real request uses, so the sizes describe a prompt
    // that will actually be sent: the model the agent names, the one given on
    // the command line, or the project's default when the agent names none. A
    // report on a model this project would never use is a curiosity rather than
    // a measurement.
    const wanted = yield* Provider.Service.use((svc) =>
      args.model
        ? Effect.succeed({
            providerID: agent.model?.providerID ?? ProviderV2.ID.make(""),
            modelID: ModelV2.ID.make(args.model),
          })
        : agent.model
          ? Effect.succeed({ providerID: agent.model.providerID, modelID: agent.model.modelID })
          : svc.defaultModel(),
    ).pipe(Effect.catchCause(() => fail(`Model not found: ${args.model}`)))
    const model = yield* Provider.Service.use((svc) => svc.getModel(wanted.providerID, wanted.modelID)).pipe(
      Effect.catchCause(() => fail(`Model not found: ${wanted.providerID}/${wanted.modelID}`)),
    )

    const report = yield* SessionPromptSize.Service.use((svc) => svc.report({ agent, model }))

    if (args.format === "json") {
      process.stdout.write(JSON.stringify(report, null, 2) + EOL)
      return
    }

    const lines: string[] = []
    lines.push(`${UI.Style.TEXT_HIGHLIGHT_BOLD}system prompt${UI.Style.TEXT_NORMAL}`)
    lines.push(`${UI.Style.TEXT_DIM}${report.agent} · ${report.model}${UI.Style.TEXT_NORMAL}`)
    lines.push("")

    const sent = report.parts.filter((part) => part.present)
    const sentTokens = report.total
    const everything = sentTokens + report.toolsTotal
    for (const part of report.parts) {
      const tokens = part.tokens ?? 0
      const share = everything === 0 ? 0 : tokens / everything
      const label = part.detail
      const amount = part.present ? SessionPromptSize.formatTokens(part.tokens) : "added per turn"
      lines.push(
        `  ${part.present ? bar(share, 24) : " ".repeat(24)} ` +
          `${SessionPromptSize.formatTokens(part.tokens).padStart(6)}  ` +
          `${part.piece.padEnd(13)} ` +
          UI.Style.TEXT_DIM +
          label +
          UI.Style.TEXT_NORMAL +
          (part.present ? "" : UI.Style.TEXT_DIM + `  (${amount})` + UI.Style.TEXT_NORMAL),
      )
    }

    if (report.tools.length > 0) {
      lines.push("")
      lines.push(UI.Style.TEXT_DIM_BOLD + `tool definitions (${report.tools.length})` + UI.Style.TEXT_NORMAL)
      for (const tool of report.tools.slice(0, args.limit)) {
        lines.push(
          `  ${SessionPromptSize.formatTokens(tool.tokens).padStart(6)}  ` +
            `${tool.name.padEnd(20)} ` +
            UI.Style.TEXT_DIM +
            `${SessionPromptSize.formatTokens(SessionPromptSize.charsAsTokens(tool.description))} description · ` +
            `${SessionPromptSize.formatTokens(SessionPromptSize.charsAsTokens(tool.schema))} schema` +
            UI.Style.TEXT_NORMAL,
        )
      }
      if (report.tools.length > args.limit) {
        lines.push(
          UI.Style.TEXT_DIM +
            `  ...and ${report.tools.length - args.limit} more, ${SessionPromptSize.formatTokens(
              report.tools.slice(args.limit).reduce((sum, tool) => sum + tool.tokens, 0),
            )} tokens` +
            UI.Style.TEXT_NORMAL,
        )
      }
    }

    lines.push("")
    lines.push(
      `sent on every request: ` +
        `${SessionPromptSize.formatTokens(sentTokens)} of prompt · ` +
        `${SessionPromptSize.formatTokens(report.toolsTotal)} of tool definitions · ` +
        `${SessionPromptSize.formatTokens(everything)} total` +
        UI.Style.TEXT_DIM +
        " (estimated at 4 characters per token, the same ratio compaction uses)" +
        UI.Style.TEXT_NORMAL,
    )

    for (const finding of report.findings) {
      lines.push("")
      lines.push(`${SEVERITY[finding.severity]}${GLYPH[finding.severity]} ${finding.title}${UI.Style.TEXT_NORMAL}`)
      if (finding.detail) lines.push(UI.Style.TEXT_DIM + "    " + finding.detail + UI.Style.TEXT_NORMAL)
      if (finding.hint) lines.push("    " + UI.Style.TEXT_INFO + finding.hint + UI.Style.TEXT_NORMAL)
    }

    process.stdout.write(lines.join(EOL).trimEnd() + EOL)
  }),
})
