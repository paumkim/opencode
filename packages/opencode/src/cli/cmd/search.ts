import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { Locale } from "@/util/locale"
import { SessionID } from "@/session/schema"
import { SessionSearch } from "@/session/search"
import { UI } from "../ui"

export const SearchCommand = effectCmd({
  command: "search <query..>",
  describe: "search the text of every message in your sessions",
  builder: (yargs) =>
    yargs
      .positional("query", {
        describe: "text to look for; the rest of the command line is used",
        type: "string",
        array: true,
        demandOption: true,
      })
      .option("session", {
        describe: "only search this session",
        type: "string",
      })
      .option("all", {
        describe: "search every project, not just the current one",
        type: "boolean",
        default: false,
      })
      .option("case", {
        describe: "match case",
        type: "boolean",
        default: false,
      })
      .option("synthetic", {
        describe: "include text the agent injected (reminders, compaction output)",
        type: "boolean",
        default: false,
      })
      .option("limit", {
        alias: "n",
        describe: "maximum number of hits (default: 50)",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["text", "json"],
        default: "text",
      }),
  handler: Effect.fn("Cli.search")(function* (args) {
    const search = yield* SessionSearch.Service
    const hits = yield* search.search({
      query: args.query.join(" "),
      sessionID: args.session ? SessionID.make(args.session) : undefined,
      all: args.all,
      caseSensitive: args.case,
      synthetic: args.synthetic,
      limit: args.limit,
    })

    if (args.format === "json") {
      process.stdout.write(JSON.stringify({ hits }, null, 2) + EOL)
      return
    }

    if (hits.length === 0) {
      process.stderr.write(UI.Style.TEXT_DIM + `No matches for "${args.query.join(" ")}"` + UI.Style.TEXT_NORMAL + EOL)
      return
    }

    const lines: string[] = []
    for (const hit of hits) {
      const time = Locale.todayTimeOrDateTime(hit.time)
      const count = hit.matches > 1 ? ` (${hit.matches} matches)` : ""
      const head = UI.Style.TEXT_INFO_BOLD + hit.sessionID + UI.Style.TEXT_NORMAL
      lines.push(`${head} ${hit.role} · ${time}${count}`)
      lines.push("  " + UI.Style.TEXT_DIM + hit.sessionTitle + UI.Style.TEXT_NORMAL)
      for (const row of hit.snippet.split("\n")) {
        lines.push("  " + UI.Style.TEXT_HIGHLIGHT + row + UI.Style.TEXT_NORMAL)
      }
      lines.push("")
    }
    process.stdout.write(lines.join(EOL).trimEnd() + EOL)
  }),
})
