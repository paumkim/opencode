import { Effect, Schema } from "effect"
import type { Scope } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Tool } from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"
import type { TerminalSessions } from "@opencode-ai/ghostty-terminal/sessions"
import * as Visible from "@opencode-ai/ghostty-terminal/visible"

declare const __GHOSTTY_TERMINAL_BUN__: boolean | undefined

/** Compile-time host gate. Node/Electron builds define this as false so the
 * Bun-only native module is omitted from their bundle. Source runs default to
 * the current host. */
export const GhosttyTerminalAvailable = typeof __GHOSTTY_TERMINAL_BUN__ === "undefined" || __GHOSTTY_TERMINAL_BUN__

export type Metadata = {
  unavailable?: boolean
  runtime?: "node"
  display?: "headless" | "visible"
  /** False when a visible terminal's window is no longer on screen. */
  windowOpen?: boolean
}

export const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "write", "screen", "resize", "kill", "list", "dispose"]),
  name: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))).annotate({
    description: "Named terminal. Required except for list and dispose (omit to dispose all your terminals).",
  }),
  display: Schema.optional(Schema.Literals(["headless", "visible"]))
    .annotate({
      description: [
        "Create only. 'headless' (default) is invisible to the user. 'visible' opens a real window on the user's screen so they can watch it.",
        "Set display='visible' whenever the user asks to see, watch, or follow the terminal ('display live', 'show me', 'I want to watch', 'on my screen', 'visible').",
      ].join(" "),
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed("headless" as const))),
  workdir: Schema.optional(Schema.String).annotate({
    description: "Create only: working directory, default project directory.",
  }),
  cols: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500))),
  rows: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200))),
  data: Schema.optional(Schema.String.check(Schema.isMaxLength(65536))).annotate({
    description:
      'Write only: literal text/keys, including control characters. To press Enter, include a carriage return in the data string — use "\\r" (which JSON decodes to a single 0x0D byte), NOT "\\\\r" (which would send literal backslash-r). "\\u0003" is Ctrl+C. Arrow Up is "\\u001b[A". Nothing is appended automatically.',
  }),
  format: Schema.optional(Schema.Literals(["plain", "html"])),
  signal: Schema.optional(Schema.Literals(["SIGTERM", "SIGKILL", "SIGINT"])),
  wait: Schema.optional(Schema.Int).annotate({
    description:
      "Screen only: milliseconds to wait before reading after a write. Default: 0 (no wait). Set to 500-2000 to give the shell time to process input.",
  }),
})

/** Report a visible terminal in the same shape as a headless one, so `list`
 * reads uniformly and the model can see at a glance which windows are on the
 * user's screen. */
function describeVisible(owner: string, entries: Visible.VisibleInfo[]) {
  const prefix = Visible.sessionPrefix(owner)
  return entries.map((entry) => ({
    name: entry.session.slice(prefix.length),
    display: "visible" as const,
    windowOpen: entry.attached,
    pid: entry.pid,
    cols: entry.cols,
    rows: entry.rows,
    exited: entry.exited,
  }))
}

export const GhosttyTerminalTool = Tool.define<
  typeof Parameters,
  Metadata,
  Config.Service | Plugin.Service | Scope.Scope
>(
  "ghostty_terminal",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const sessions = new Map<string, TerminalSessions>()
        // Which named terminals the user can actually see. Absent means headless.
        const visible = new Set<string>()
        const state = { sessions, visible, closed: false }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            state.closed = true
            const errors: unknown[] = []
            for (const registry of sessions.values()) {
              try {
                registry.close()
              } catch (error) {
                errors.push(error)
              }
            }
            for (const name of visible) {
              try {
                Visible.dispose(name)
              } catch (error) {
                errors.push(error)
              }
            }
            sessions.clear()
            visible.clear()
            if (errors.length) throw new AggregateError(errors, "Terminal cleanup failed")
          }),
        )
        return state
      }),
    )

    return {
      description: [
        "DEFAULT fast interactive terminal for interactive/TUI/persistent work. Use instead of tmux send-keys/capture-pane or bash polling loops.",
        "",
        "display=\'visible\' ON create OPENS A REAL WINDOW ON THE USER\'S SCREEN. display=\'headless\' (the default) is invisible to them.",
        "When the user asks to see, watch, follow, or observe the terminal — \"display live\", \"display it live\", \"live display\", \"show me\", \"let me watch\", \"I want to see it\", \"on my screen\", \"visible\" — you MUST create it with display=\'visible\'. The user asked to see it; an invisible terminal does not answer the request.",
        "Do not answer a request for a live display with a headless terminal, and do not substitute the bash tool. If display=\'visible\' fails because the machine has no display, say so plainly and offer headless instead; never silently continue headless and imply they can see it.",
        "",
        "Persistent named Ghostty terminals with a real interactive shell (full TUI alt-screen, cursor movement, truecolor). Requires Bun and the built native Ghostty package.",
        "create starts the configured shell in workdir (default project directory), cols=80, rows=24.",
        "write sends literal keys/text, without appending Enter. Use JSON control characters, not spelled-out key names.",
        "screen calls GhosttyTerminal.readScreen: the current visible viewport, NOT raw output or a transcript. In visible mode it returns what the user is looking at, so you and the user always see the same thing.",
        "Use wait=N (ms) on screen after write to give the shell time to process input before reading.",
        "plain captures visible text; html preserves styles/colors as HTML, not a PNG screenshot (headless only).",
        "resize requires cols and rows; kill signals the owned shell (SIGTERM default), retaining the final screen until dispose.",
        "SIGINT writes Ctrl+C; other signals target the shell PID, not all descendants. Interactive shells may ignore SIGTERM; use dispose for forced cleanup.",
        "list reports names, PIDs, dimensions and exit status. dispose removes one terminal, or all your terminals when name is omitted; it is idempotent.",
        "In visible mode the user may close the window themselves; the session then stays drivable and invisible, so re-open a window before claiming they can see it.",
        "Names are isolated by project, conversation and agent. Sessions persist between calls, not across process restarts.",
        "Dispose when finished. Project/runtime shutdown and process exit also release terminals. At most 16 terminals per owner.",
        "create/write require ghostty_terminal and bash permission. The tool inherits the configured bash permission level. Use the bash tool for restricted commands.",
      ].join("\n"),
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          if (!GhosttyTerminalAvailable) {
            return {
              title: "terminal unavailable",
              metadata: { unavailable: true, runtime: "node" } satisfies Metadata,
              output:
                "ghostty_terminal is unavailable in Node/Electron hosts; it requires the Bun runtime with the native Ghostty library. Use the bash tool for non-interactive commands.",
            }
          }
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
            yield* ctx.ask({
              permission: ShellID.ToolID,
              patterns: ["*"],
              always: ["*"],
              metadata: { ...args, description: "Interactive shell input" },
            })
            if (ctx.abort.aborted) throw new Error("Terminal call aborted")
          }
          const ins = yield* InstanceState.context
          if (ctx.abort.aborted) throw new Error("Terminal call aborted")
          const cwd =
            args.action === "create"
              ? yield* Effect.promise(async () => {
                  const cwd = await fs.realpath(path.resolve(ins.directory, args.workdir ?? "."))
                  if (ctx.abort.aborted) throw new Error("Terminal call aborted")
                  return cwd
                })
              : ins.directory
          if (args.action === "create") {
            const directory = yield* Effect.promise(() => fs.realpath(ins.directory))
            if (ctx.abort.aborted) throw new Error("Terminal call aborted")
            // '/' is the non-git worktree sentinel; it must never grant external access.
            const worktree = ins.worktree === "/" ? undefined : yield* Effect.promise(() => fs.realpath(ins.worktree))
            if (ctx.abort.aborted) throw new Error("Terminal call aborted")
            if (
              !FSUtil.contains(directory, cwd) &&
              !(worktree && worktree !== path.parse(worktree).root && FSUtil.contains(worktree, cwd))
            ) {
              const glob = FSUtil.normalizePathPattern(path.join(cwd, "*"))
              yield* ctx.ask({
                permission: "external_directory",
                patterns: [glob],
                always: [glob],
                metadata: { filepath: cwd, parentDir: cwd },
              })
              if (ctx.abort.aborted) throw new Error("Terminal call aborted")
            }
          }
          const local = yield* InstanceState.get(state)
          if (ctx.abort.aborted) throw new Error("Terminal call aborted")
          const owners = local.sessions
          const owner = JSON.stringify([ctx.sessionID, ctx.agent])
          // tmux is one global server, so a visible session is named per owner
          // and the mapping back to the tool's short name is kept in `visible`.
          const tmuxName = args.name ? Visible.sessionName(owner, args.name) : undefined
          const creatingVisible = args.action === "create" && args.display === "visible"
          // A named session is visible if it was created visible, or is being
          // created visible now. Everything else below is headless. `list` is
          // excluded because it reports every terminal rather than addressing
          // one, and is handled by the merge further down.
          const visibleSession =
            tmuxName !== undefined &&
            args.action !== "list" &&
            (creatingVisible || local.visible.has(tmuxName))
              ? tmuxName
              : undefined
          if (visibleSession) {
            const name = args.name!
            if (args.action === "create") {
              if (Visible.exists(visibleSession)) {
                throw new Error(`Terminal session '${name}' already exists`)
              }
              const cfg = yield* config.get()
              if (ctx.abort.aborted) throw new Error("Terminal call aborted")
              const extra = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
                { env: {} },
              )
              if (ctx.abort.aborted) throw new Error("Terminal call aborted")
              if (local.closed) throw new Error("Terminal instance is disposed")
              // The window is created in the caller's own session so a Wayland
              // compositor can surface it, and the display is inherited rather
              // than pinned, so it lands on the display the user is looking at.
              const env = Object.fromEntries(
                Object.entries({ ...process.env, ...extra.env }).filter(
                  (pair): pair is [string, string] => typeof pair[1] === "string",
                ),
              )
              try {
                Visible.create({
                  session: visibleSession,
                  cwd,
                  cols: args.cols ?? 80,
                  rows: args.rows ?? 24,
                  env,
                  title: `opencode: ${name}`,
                  shell: Shell.acceptable(cfg.shell),
                })
              } catch (error) {
                if (!(error instanceof Visible.VisibleUnavailableError)) throw error
                return {
                  title: "terminal display unavailable",
                  metadata: { display: "visible", windowOpen: false } satisfies Metadata,
                  output: `NO WINDOW WAS OPENED — the user asked for a live display and did not get one.\n\n${error.message}\n${error.hint}`,
                }
              }
              local.visible.add(visibleSession)
            }
            if (args.action === "write") Visible.write(visibleSession, args.data ?? "")
            if (args.action === "resize") Visible.resize(visibleSession, args.cols ?? 80, args.rows ?? 24)
            if (args.action === "kill") Visible.kill(visibleSession, args.signal)
            if (args.action === "dispose") {
              Visible.dispose(visibleSession)
              local.visible.delete(visibleSession)
            }
            if (args.action === "screen") {
              const read = () => Visible.screen(visibleSession, args.format)
              const screen = args.wait
                ? yield* Effect.promise(
                    () => new Promise<string>((resolve) => setTimeout(() => resolve(read()), args.wait)),
                  )
                : read()
              const info = Visible.info(visibleSession)
              return {
                title: `terminal screen ${name}`,
                metadata: {
                  display: "visible",
                  windowOpen: info?.attached ?? false,
                } satisfies Metadata,
                output:
                  (screen || "(empty screen)") +
                  (info?.attached
                    ? ""
                    : "\n[NOTE: this terminal was created visible, but its window is not currently on screen — the user cannot see it. Re-open the window before telling them to look.]"),
              }
            }
            const info = Visible.info(visibleSession)
            return {
              title: `terminal ${args.action} ${name}`,
              metadata: { display: "visible", windowOpen: info?.attached ?? false } satisfies Metadata,
              output:
                JSON.stringify({
                  name,
                  display: "visible",
                  windowOpen: info?.attached ?? false,
                  pid: info?.pid,
                  cols: info?.cols,
                  rows: info?.rows,
                  exited: info?.exited,
                }) + "\nA real window is open on the user's screen for this terminal.",
            }
          }
          const current = owners.get(owner)
          if (!current && args.action !== "create") {
            if (args.action !== "list" && args.action !== "dispose")
              throw new Error(`Unknown terminal session '${args.name}'`)
            const owned = Visible.list(Visible.sessionPrefix(owner))
            if (args.action === "dispose") {
              for (const entry of owned) {
                Visible.dispose(entry.session)
                local.visible.delete(entry.session)
              }
            }
            return {
              title: "terminal " + args.action,
              metadata: {} satisfies Metadata,
              output: args.action === "list" ? JSON.stringify(describeVisible(owner, owned)) : "Disposed terminals.",
            }
          }
          const sessions =
            current ??
            (yield* Effect.promise(async () => {
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
            const extra = yield* plugin.trigger(
              "shell.env",
              { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
              { env: {} },
            )
            if (ctx.abort.aborted) throw new Error("Terminal call aborted")
            if (local.closed) throw new Error("Terminal instance is disposed")
            registry.create(
              name,
              {
                cwd,
                cols: args.cols ?? 80,
                rows: args.rows ?? 24,
                env: Object.fromEntries(
                  Object.entries({ ...process.env, ...extra.env }).filter(
                    (pair): pair is [string, string] => typeof pair[1] === "string",
                  ),
                ),
              },
              Shell.acceptable(cfg.shell),
            )
          }
          if (args.action === "write") registry.write(name, args.data ?? "")
          if (args.action === "resize") registry.resize(name, args.cols ?? 80, args.rows ?? 24)
          if (args.action === "kill") registry.kill(name, args.signal)
          if (args.action === "dispose") {
            if (args.name) registry.dispose(args.name)
            else registry.disposeAll()
          }
          // A name-less dispose/list has to cover the visible sessions too, or
          // the windows the user can see would outlive the headless ones.
          const owned = Visible.list(Visible.sessionPrefix(owner))
          if (args.action === "dispose" && !args.name) {
            for (const entry of owned) {
              Visible.dispose(entry.session)
              local.visible.delete(entry.session)
            }
          }
          return {
            title: `terminal ${args.action}${name ? " " + name : ""}`,
            metadata: {} satisfies Metadata,
            output:
              args.action === "screen"
                ? args.wait
                  ? yield* Effect.promise((signal: AbortSignal) =>
                      registry.screenWait(name, args.format, { wait: args.wait }),
                    )
                  : registry.screen(name, args.format) || "(empty screen)"
                : args.action === "list"
                  ? JSON.stringify([
                      ...registry.list().map((entry) => ({ ...entry, display: "headless" })),
                      ...describeVisible(owner, owned),
                    ])
                  : args.action === "dispose"
                    ? "Disposed terminals."
                    : JSON.stringify({ ...registry.info(name), display: "headless" }) +
                      "\nThis terminal is headless: the user CANNOT see it. Use display='visible' if they asked to watch.",
          }
        }).pipe(Effect.orDie),
    }
  }),
)
