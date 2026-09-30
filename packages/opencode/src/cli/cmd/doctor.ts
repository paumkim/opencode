import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { Doctor } from "@/doctor/doctor"
import { DoctorCollect } from "@/doctor/collect"
import { DoctorRender } from "@/doctor/render"

export const DoctorCommand = effectCmd({
  command: "doctor",
  describe: "diagnose configuration, providers, MCP servers, and tooling",
  builder: (yargs) =>
    yargs
      .option("json", {
        describe: "emit the report as JSON on stdout",
        type: "boolean" as const,
        default: false,
      })
      .option("brief", {
        describe: "only report errors and warnings",
        type: "boolean" as const,
        default: false,
      })
      .option("mcp", {
        describe: "connect to configured MCP servers to report their status",
        type: "boolean" as const,
        default: true,
      }),
  handler: Effect.fn("Cli.doctor")(function* (args) {
    const findings = yield* DoctorCollect.collect({ mcp: args.mcp })

    // Findings go to stderr and the JSON document to stdout, so `--json` can be
    // piped while the human summary still shows if the terminal is attached.
    if (args.json) {
      process.stdout.write(DoctorRender.renderJSON(findings, { brief: args.brief }) + EOL)
    } else {
      process.stderr.write(DoctorRender.renderText(findings, { brief: args.brief }) + EOL)
    }

    process.exitCode = Doctor.exitCode(findings)
  }),
})
