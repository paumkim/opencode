import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/attach"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import { errorMessage } from "./util/error"
import { PluginCommand } from "./cli/cmd/plug"
import { Heap } from "./cli/heap"
import { Flag } from "@opencode-ai/core/flag/flag"

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("internal-version", {
    describe: "show internal fork build version (separate from compatibility version)",
    type: "boolean",
  })
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("debug", {
    describe: "debug mode: DEBUG logs, print-logs, JSON streaming, and thinking blocks",
    type: "boolean",
    default: false,
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.internalVersion) {
      const { internalVersion } = await import("@opencode-ai/core/installation/internal-version")
      console.log(internalVersion())
      process.exit(0)
    }
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    if (opts.debug) {
      process.env.OPENCODE_LOG_LEVEL = "DEBUG"
      process.env.OPENCODE_PRINT_LOGS = "1"
    }
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    Heap.start()

    // Keep the per-provider client versions current in the background. Header
    // construction reads the resulting cache synchronously and never blocks on
    // the network, so this only costs one small file read per request. Failures
    // are swallowed so a registry outage cannot affect startup.
    void import("@opencode-ai/core/installation/provider-identity")
      .then((module) => module.ProviderIdentity.refreshStale())
      .catch(() => {})

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)

    // System One is opt-in. Required mode is an explicit enablement request.
    if (process.env.SYSTEM_ONE_REQUIRED === "1") process.env.SYSTEM_ONE_ENABLED = "1"
    if (process.env.SYSTEM_ONE_START_DAEMON === "1" && !Flag.OPENCODE_PURE && !opts.pure) {
      try {
        const { existsSync } = await import("node:fs")
        const path = await import("node:path")
        const daemonDir = process.env.SYSTEM_ONE_DAEMON_DIR
        if (daemonDir && existsSync(daemonDir)) {
          const pidFile = path.join(daemonDir, "daemon.pid")
          if (existsSync(pidFile)) {
            const pid = Number.parseInt((await (await import("node:fs/promises")).readFile(pidFile, "utf-8")).trim(), 10)
            if (!Number.isInteger(pid) || pid <= 0) throw new Error("invalid daemon pid")
            try {
              process.kill(pid, 0)
            } catch {
              await startDaemon(daemonDir)
              return
            }
            const healthUrl = `${process.env.SYSTEM_ONE_URL ?? "http://127.0.0.1:9999"}/health`
            const health = (await fetch(healthUrl, { signal: AbortSignal.timeout(500) }).then((response) => response.json())) as {
              status?: string
              model_loaded?: boolean
            }
            if (health.status !== "ok" || health.model_loaded !== true) {
              throw new Error("System One daemon exists but is not ready")
            }
          } else {
            await startDaemon(daemonDir)
          }
        }
      } catch (error) {
        if (process.env.SYSTEM_ONE_REQUIRED === "1") {
          throw new Error(`System One daemon is required but unavailable: ${errorMessage(error)}`)
        }
        process.stderr.write(`System One daemon startup skipped: ${errorMessage(error)}\n`)
      }
    }
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command(DbCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

async function startDaemon(daemonDir: string) {
  const { spawn } = await import("node:child_process")
  const { access, readFile } = await import("node:fs/promises")
  const path = await import("node:path")
  const healthUrl = `${process.env.SYSTEM_ONE_URL ?? "http://127.0.0.1:9999"}/health`
  const timeoutMs = Number.parseInt(process.env.SYSTEM_ONE_START_TIMEOUT_MS ?? "15000", 10)
  const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000)
  const pidFile = path.join(daemonDir, "daemon.pid")

  try {
    await access(path.join(daemonDir, "start.sh"))
  } catch {
    throw new Error(`System One daemon directory is missing or invalid: ${daemonDir}`)
  }

  await new Promise<void>((resolve, reject) => {
    // start.sh owns dependency setup, model-cache environment, logging, and
    // daemon.pid. Keep its output hidden so prompts/credentials can never be
    // copied into CLI diagnostics.
    const child = spawn("/bin/bash", [path.join(daemonDir, "start.sh")], {
      cwd: daemonDir,
      stdio: "ignore",
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    })
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      child.removeAllListeners()
      if (error) reject(error)
      else resolve()
    }
    child.once("error", () => finish(new Error("System One daemon startup command failed")))
    child.once("exit", (code, signal) => {
      if (code !== 0) finish(new Error(`System One daemon startup command failed (code=${code ?? "null"}, signal=${signal ?? "none"})`))
      else finish()
    })
  })

  const check = async (): Promise<void> => {
    if (Date.now() >= deadline) throw new Error("System One daemon readiness timed out")
    try {
      const pid = Number.parseInt((await readFile(pidFile, "utf-8")).trim(), 10)
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("System One daemon did not write a valid PID")
      process.kill(pid, 0)
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(500) })
      const health = (await response.json()) as { status?: string; model_loaded?: boolean }
      if (!response.ok || health.status !== "ok" || health.model_loaded !== true) return new Promise<void>((resolve) => setTimeout(resolve, 100)).then(check)
    } catch {
      return new Promise<void>((resolve) => setTimeout(resolve, 100)).then(check)
    }
  }
  await check()
}

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
