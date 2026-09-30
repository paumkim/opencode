import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { PermissionExplain } from "@/permission/explain"
import { UI } from "../ui"

const ACTION: Record<string, string> = {
  allow: UI.Style.TEXT_SUCCESS,
  deny: UI.Style.TEXT_DANGER,
  ask: UI.Style.TEXT_WARNING,
}

const paint = (action: string, text: string) => (ACTION[action] ?? UI.Style.TEXT_NORMAL) + text + UI.Style.TEXT_NORMAL

export const PermissionExplainCommand = effectCmd({
  command: "explain <permission> [pattern..]",
  describe: "explain which permission rule decided, and why",
  builder: (yargs) =>
    yargs
      .positional("permission", {
        describe: "the permission that was asked for, e.g. bash, edit, webfetch",
        type: "string",
        demandOption: true,
      })
      .positional("pattern", {
        describe: "the thing being permitted, e.g. a file path or a command",
        type: "string",
        array: true,
      })
      .option("agent", {
        describe: "agent whose rules apply (default: the session's default agent)",
        type: "string",
      })
      .option("session", {
        describe: "session whose own rules apply on top of the agent's",
        type: "string",
      })
      .option("all", {
        describe: "list every rule, not only those covering this permission",
        type: "boolean",
        default: false,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["text", "json"],
        default: "text",
      }),
  handler: Effect.fn("Cli.permission.explain")(function* (args) {
    // Everything after the permission name is the thing being permitted, so a
    // command like `rm -rf /` arrives as one argument and asks about itself
    // rather than being read as flags.
    const pattern = args.pattern.length > 0 ? args.pattern.join(" ") : "*"
    const agentName = args.agent ?? (yield* Agent.Service.use((svc) => svc.defaultAgent()).pipe(Effect.orDie))
    const agent = yield* Agent.Service.use((svc) => svc.get(agentName)).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    if (!agent) return yield* fail(`Agent not found: ${agentName}`)

    // A session's own rules are merged over the agent's when a permission is
    // asked, so explaining the agent alone answers a different question than
    // the one being asked whenever a session is in play.
    let sessionRules: PermissionV1.Ruleset | undefined
    if (args.session) {
      const session = yield* Session.Service.use((svc) => svc.get(SessionID.make(args.session))).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
      if (!session) return yield* fail(`Session not found: ${args.session}`)
      if (session.permission?.length) sessionRules = session.permission
    }

    const explanation = PermissionExplain.explain(
      args.permission,
      pattern,
      agent.permission,
      ...(sessionRules ? [sessionRules] : []),
    )

    if (args.format === "json") {
      process.stdout.write(JSON.stringify({ agent: agent.name, session: args.session, ...explanation }, null, 2) + EOL)
      return
    }

    const lines: string[] = []
    lines.push(
      `${UI.Style.TEXT_HIGHLIGHT_BOLD}${args.permission}${UI.Style.TEXT_NORMAL}` +
        ` ${UI.Style.TEXT_DIM}for${UI.Style.TEXT_NORMAL} ` +
        `${UI.Style.TEXT_HIGHLIGHT}${pattern}${UI.Style.TEXT_NORMAL}`,
    )
    lines.push(
      `${UI.Style.TEXT_DIM}agent ${agent.name}${args.session ? ` · session ${args.session}` : ""}${UI.Style.TEXT_NORMAL}`,
    )
    lines.push("")
    lines.push(
      paint(explanation.winner.action, explanation.winner.action) +
        " " +
        UI.Style.TEXT_DIM +
        explanation.why +
        UI.Style.TEXT_NORMAL,
    )

    // A busy agent can carry eighty rules, most of them about other tools, and
    // printing all of them buries the four that decide the question. The rules
    // that cover this permission are the ones that can matter, and `--all` is
    // there for when someone wants to see the file itself.
    const relevant = args.all
      ? explanation.candidates
      : explanation.candidates.filter((candidate) => candidate.permissionMatched || candidate.matches)
    const hidden = explanation.candidates.length - relevant.length

    if (explanation.candidates.length === 0) {
      lines.push("")
      lines.push(UI.Style.TEXT_DIM + "This agent has no permission rules of its own." + UI.Style.TEXT_NORMAL)
    } else if (relevant.length === 0) {
      lines.push("")
      lines.push(
        UI.Style.TEXT_DIM +
          `No rule covers "${args.permission}"; ${explanation.candidates.length} rule` +
          `${explanation.candidates.length === 1 ? "" : "s"} cover other permissions.` +
          UI.Style.TEXT_NORMAL,
      )
    } else {
      const ruleWidth = Math.min(
        46,
        Math.max(12, ...relevant.map((candidate) => PermissionExplain.describeRule(candidate.rule).length)),
      )
      lines.push("")
      lines.push(UI.Style.TEXT_DIM_BOLD + `   #  ${"rule".padEnd(ruleWidth)}  decision` + UI.Style.TEXT_NORMAL)
      for (const candidate of relevant) {
        const won = candidate.index === explanation.winnerIndex
        const mark = won ? "→" : candidate.matches ? "✔" : "·"
        const rule = PermissionExplain.describeRule(candidate.rule)
        const why = candidate.matches ? "" : UI.Style.TEXT_DIM + " (pattern does not match)" + UI.Style.TEXT_NORMAL
        lines.push(
          `  ${mark} ${String(candidate.index + 1).padStart(2)}  ${rule.padEnd(ruleWidth)}  ` +
            `${paint(candidate.rule.action, candidate.rule.action)}${why}`,
        )
      }
      if (hidden > 0) {
        lines.push("")
        lines.push(
          UI.Style.TEXT_DIM +
            `${hidden} more rule${hidden === 1 ? "" : "s"} cover other permissions. Pass --all to see them.` +
            UI.Style.TEXT_NORMAL,
        )
      }
    }

    if (explanation.matched.length > 1) {
      lines.push("")
      lines.push(
        UI.Style.TEXT_DIM +
          `${explanation.matched.length} rules matched; the last one wins, so order is what decides this.` +
          UI.Style.TEXT_NORMAL,
      )
    }

    process.stdout.write(lines.join(EOL).trimEnd() + EOL)
  }),
})

export const PermissionCommand = effectCmd({
  command: "permission",
  describe: "inspect and explain permission decisions",
  builder: (yargs) => yargs.command(PermissionExplainCommand).demandCommand(),
  handler: Effect.fn("Cli.permission")(function* () {
    // `demandCommand` guarantees a subcommand; yargs still calls this handler.
    return yield* Effect.void
  }),
})
