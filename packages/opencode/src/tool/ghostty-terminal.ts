import { Effect, Schema } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Tool } from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"
import { Wildcard } from "@/util/wildcard"
import type { TerminalSessions } from "@opencode-ai/ghostty-terminal/sessions"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "write", "screen", "resize", "kill", "list", "dispose"]),
  name: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))).annotate({
    description: "Named terminal. Required except for list and dispose (omit to dispose all your terminals).",
  }),
  workdir: Schema.optional(Schema.String).annotate({ description: "Create only: working directory, default project directory." }),
  cols: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500))),
  rows: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200))),
  data: Schema.optional(Schema.String.check(Schema.isMaxLength(65536))).annotate({
    description: "Write only: literal text/keys, including control characters. JSON \"\\r\" presses Enter, \"\\u0003\" is Ctrl+C; arrow Up is \"\\u001b[A\". Nothing is appended automatically.",
  }),
  format: Schema.optional(Schema.Literals(["plain", "html"])),
  signal: Schema.optional(Schema.Literals(["SIGTERM", "SIGKILL", "SIGINT"])),
  wait: Schema.optional(Schema.Int).annotate({
    description: "Screen only: milliseconds to wait before reading after a write. Default: 0 (no wait). Set to 500-2000 to give the shell time to process input.",
  }),
})

export const GhosttyTerminalTool = Tool.define(
  "ghostty_terminal",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service
    const conversations = yield* Session.Service
    const state = yield* InstanceState.make(() => Effect.gen(function* () {
      const sessions = new Map<string, TerminalSessions>()
      const state = { sessions, closed: false }
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        state.closed = true
        const errors: unknown[] = []
        for (const registry of sessions.values()) {
          try { registry.close() } catch (error) { errors.push(error) }
        }
        sessions.clear()
        if (errors.length) throw new AggregateError(errors, "Terminal cleanup failed")
      }))
      return state
    }))

    return {
      description: [
        "DEFAULT fast interactive terminal for interactive/TUI/persistent work. Use instead of tmux send-keys/capture-pane or bash polling loops.",
        "Persistent named Ghostty terminals with a real interactive shell (full TUI alt-screen, cursor movement, truecolor). Requires Bun and the built native Ghostty package.",
        "create starts the configured shell in workdir (default project directory), cols=80, rows=24.",
        "write sends literal keys/text, without appending Enter. Use JSON control characters, not spelled-out key names.",
        "screen calls GhosttyTerminal.readScreen: the current visible viewport, NOT raw output or a transcript.",
        "Use wait=N (ms) on screen after write to give the shell time to process input before reading.",
        "plain captures visible text; html preserves styles/colors as HTML, not a PNG screenshot.",
        "resize requires cols and rows; kill signals the owned shell (SIGTERM default), retaining the final screen until dispose.",
        "SIGINT writes Ctrl+C; other signals target the shell PID, not all descendants. Interactive shells may ignore SIGTERM; use dispose for forced cleanup.",
        "list reports names, PIDs, dimensions and exit status. dispose removes one terminal, or all your terminals when name is omitted; it is idempotent.",
        "Names are isolated by project, conversation and agent. Sessions persist between calls, not across process restarts.",
        "Dispose when finished. Project/runtime shutdown and process exit also release terminals. At most 16 terminals per owner.",
        "create/write require ghostty_terminal and broad bash permission. Interactive execution is unavailable when configured Bash rules contain any deny or pattern-specific ask, even if a broader allow overrides it. Use the bash tool for restricted commands.",
      ].join("\n"),
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => Effect.gen(function* () {
        if (ctx.abort.aborted) throw new Error("Terminal call aborted")
        if (args.action !== "list" && args.action !== "dispose" && !args.name) throw new Error("name is required")
        if (args.action === "write" && args.data === undefined) throw new Error("write requires data")
        if (args.action === "resize" && (args.cols === undefined || args.rows === undefined)) {
          throw new Error("resize requires cols and rows")
        }
        yield* ctx.ask({
          permission: "ghostty_terminal",
          patterns: [args.action],
          always: ["*"],
          metadata: { ...args },
        })
        if (ctx.abort.aborted) throw new Error("Terminal call aborted")
        if (args.action === "create" || args.action === "write") {
          // This is the V1 tool runtime: SessionTools merges resolved agent and session rules.
          // V2 `permissions` config is rejected by config/v2-compat, not interpreted here.
          const agent = yield* agents.get(ctx.agent)
          if (ctx.abort.aborted) throw new Error("Terminal call aborted")
          if (!agent) throw new Error("Cannot verify interactive Bash policy: unknown agent")
          const session = yield* conversations.get(ctx.sessionID)
          if (ctx.abort.aborted) throw new Error("Terminal call aborted")
          const rules = Permission.merge(agent.permission, session.permission ?? [])
          // Keystrokes combine across calls. Do not try to parse commands or let a saved
          // broad approval erase restrictions. Conservatively reject even shadowed rules.
          const restricted = rules.some(
            (rule) =>
              Wildcard.match(ShellID.ToolID, rule.permission) &&
              (rule.action === "deny" || (rule.action === "ask" && rule.pattern !== "*")),
          )
          if (restricted) {
            throw new Error("Unrestricted interactive Bash is unavailable with deny or pattern-specific ask rules. Use the bash tool for restricted commands.")
          }
          const effective = Permission.evaluate(ShellID.ToolID, "*", rules)
          if (effective.action === "deny" || (effective.action === "ask" && effective.pattern !== "*")) {
            throw new Error("Unrestricted interactive Bash is unavailable with deny or pattern-specific ask rules. Use the bash tool for restricted commands.")
          }
          yield* ctx.ask({
            permission: ShellID.ToolID,
            patterns: ["*"],
            always: ["*"],
            metadata: { ...args, description: "Unrestricted interactive shell input" },
          })
          if (ctx.abort.aborted) throw new Error("Terminal call aborted")
        }
        const ins = yield* InstanceState.context
        if (ctx.abort.aborted) throw new Error("Terminal call aborted")
        const cwd = args.action === "create" ? yield* Effect.promise(async () => {
          const cwd = await fs.realpath(path.resolve(ins.directory, args.workdir ?? "."))
          if (ctx.abort.aborted) throw new Error("Terminal call aborted")
          return cwd
        }) : ins.directory
        if (args.action === "create") {
          const directory = yield* Effect.promise(() => fs.realpath(ins.directory))
          if (ctx.abort.aborted) throw new Error("Terminal call aborted")
          // '/' is the non-git worktree sentinel; it must never grant external access.
          const worktree = ins.worktree === "/" ? undefined : yield* Effect.promise(() => fs.realpath(ins.worktree))
          if (ctx.abort.aborted) throw new Error("Terminal call aborted")
          if (!FSUtil.contains(directory, cwd) && !(worktree && worktree !== path.parse(worktree).root && FSUtil.contains(worktree, cwd))) {
            const glob = FSUtil.normalizePathPattern(path.join(cwd, "*"))
            yield* ctx.ask({
              permission: "external_directory", patterns: [glob], always: [glob],
              metadata: { filepath: cwd, parentDir: cwd },
            })
            if (ctx.abort.aborted) throw new Error("Terminal call aborted")
          }
        }
        const local = yield* InstanceState.get(state)
        if (ctx.abort.aborted) throw new Error("Terminal call aborted")
        const owners = local.sessions
        const owner = JSON.stringify([ctx.sessionID, ctx.agent])
        const current = owners.get(owner)
        if (!current && args.action !== "create") {
          if (args.action !== "list" && args.action !== "dispose") throw new Error(`Unknown terminal session '${args.name}'`)
          return { title: "terminal " + args.action, metadata: {}, output: args.action === "list" ? "[]" : "Disposed terminals." }
        }
        const sessions = current ?? (yield* Effect.promise(async () => {
          // Do not import bun:ffi/bun-pty during tool registry startup (including Node hosts).
          const { TerminalSessions } = await import("@opencode-ai/ghostty-terminal/sessions")
          if (ctx.abort.aborted) throw new Error("Terminal call aborted")
          return new TerminalSessions()
        }))
        // Import/permission waits can race another call. Use the existing owner, never overwrite it.
        if (local.closed) throw new Error("Terminal instance is disposed")
        if (ctx.abort.aborted) throw new Error("Terminal call aborted")
        const registry = owners.get(owner) ?? sessions
        owners.set(owner, registry)
        const name = args.name ?? ""
        if (args.action === "create") {
          const cfg = yield* config.get()
          if (ctx.abort.aborted) throw new Error("Terminal call aborted")
          if (local.closed) throw new Error("Terminal instance is disposed")
          const extra = yield* plugin.trigger("shell.env", { cwd, sessionID: ctx.sessionID, callID: ctx.callID }, { env: {} })
          if (ctx.abort.aborted) throw new Error("Terminal call aborted")
          if (local.closed) throw new Error("Terminal instance is disposed")
          registry.create(name, {
            cwd, cols: args.cols ?? 80, rows: args.rows ?? 24,
            env: Object.fromEntries(Object.entries({ ...process.env, ...extra.env }).filter((pair): pair is [string, string] => typeof pair[1] === "string")),
          }, Shell.acceptable(cfg.shell))
        }
        if (args.action === "write") registry.write(name, args.data ?? "")
        if (args.action === "resize") registry.resize(name, args.cols ?? 80, args.rows ?? 24)
        if (args.action === "kill") registry.kill(name, args.signal)
        if (args.action === "dispose") {
          if (args.name) registry.dispose(args.name)
          else registry.disposeAll()
        }
        return {
          title: `terminal ${args.action}${name ? " " + name : ""}`,
          metadata: {},
          output: args.action === "screen" ? args.wait
            ? yield* Effect.promise((signal: AbortSignal) => registry.screenWait(name, args.format, { wait: args.wait }))
            : registry.screen(name, args.format) || "(empty screen)"
            : args.action === "list" ? JSON.stringify(registry.list())
            : args.action === "dispose" ? "Disposed terminals."
            : JSON.stringify(registry.info(name)) + "\nUse screen (readScreen) to visually verify the result.",
        }
      }).pipe(Effect.orDie),
    }
  }),
)
