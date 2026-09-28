import { TextAttributes } from "@opentui/core"
import { fileURLToPath } from "bun"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { For, Match, Switch, Show, createMemo } from "solid-js"

export type DialogStatusProps = {}

/**
 * Renders one capability's list, keeping "the server said there are none" apart
 * from "the server could not be read".
 *
 * A failed read used to land as an empty list, so this dialog reported "No MCP
 * Servers" and "No Formatters" for a server that was simply unreachable — a
 * factual claim about the user's setup, drawn from a read that never landed.
 * When the read failed, the reason is shown instead of a count.
 */
function Capability(props: {
  unreadable: string | undefined
  label: string
  empty: string
  count: number
  children: unknown
}) {
  const { theme } = useTheme()
  return (
    <Show
      when={props.unreadable === undefined}
      fallback={
        <text fg={theme.warning}>
          {props.label} unavailable: {props.unreadable}
        </text>
      }
    >
      <Show when={props.count > 0} fallback={<text fg={theme.text}>{props.empty}</text>}>
        <box>
          <text fg={theme.text}>
            {props.count} {props.label}
          </text>
          {props.children as never}
        </box>
      </Show>
    </Show>
  )
}

/**
 * Human names for reads that have no list of their own to annotate. The
 * capability sections above cover mcp, lsp and formatter; everything else
 * recorded a failure here rather than pretending it had nothing.
 */
const READ_LABELS: Record<string, string> = {
  command: "Custom commands",
  mcp_resource: "MCP resources",
  session_status: "Session status",
  provider_auth: "Provider auth methods",
  vcs: "Branch",
  session: "Session list",
  capabilities: "Feature capabilities",
  console_state: "Console account",
}

/** Keys already given their own section above, so they are not listed twice. */
const SHOWN_ELSEWHERE = new Set(["mcp", "lsp", "formatter"])

/**
 * Reports every recorded read failure this dialog does not already show.
 *
 * Five of the nine recorded failures had no reader anywhere: a failed
 * `session.status` read leaves a running background subagent displaying as
 * stopped, and a failed `command.list` silently removes slash-command
 * completion — both with nothing on screen explaining why. Deriving the list
 * from the store rather than a hand-maintained subset means a read cannot be
 * added later and quietly become invisible again.
 *
 * `session` and the project read are shown in the session list dialog, where
 * the staleness actually matters, so they are not repeated here.
 */
function UnreadableReads() {
  const sync = useSync()
  const { theme } = useTheme()
  const failures = createMemo(() =>
    Object.entries(sync.data.unreadable)
      .filter(([key, reason]) => reason !== undefined && !SHOWN_ELSEWHERE.has(key) && key !== "session")
      .map(([key, reason]) => ({ label: READ_LABELS[key] ?? key, reason: reason as string })),
  )
  return (
    <Show when={failures().length > 0}>
      <box flexDirection="column">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Could not read
        </text>
        <For each={failures()}>
          {(item) => (
            <text fg={theme.warning} wrapMode="word">
              • {item.label}: {item.reason}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

export function DialogStatus() {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()

  const enabledFormatters = createMemo(() => sync.data.formatter.filter((f) => f.enabled))

  const plugins = createMemo(() => {
    const list = sync.data.config.plugin ?? []
    const result = list.map((item) => {
      const value = typeof item === "string" ? item : item[0]
      if (value.startsWith("file://")) {
        const path = fileURLToPath(value)
        const parts = path.split("/")
        const filename = parts.pop() || path
        if (!filename.includes(".")) return { name: filename }
        const basename = filename.split(".")[0]
        if (basename === "index") {
          const dirname = parts.pop()
          const name = dirname || basename
          return { name }
        }
        return { name: basename }
      }
      const index = value.lastIndexOf("@")
      if (index <= 0) return { name: value, version: "latest" }
      const name = value.substring(0, index)
      const version = value.substring(index + 1)
      return { name, version }
    })
    return result.toSorted((a, b) => a.name.localeCompare(b.name))
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Status
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Capability
        unreadable={sync.data.unreadable.mcp}
        label="MCP Servers"
        empty="No MCP Servers"
        count={Object.keys(sync.data.mcp).length}
      >
        <For each={Object.entries(sync.data.mcp)}>
          {([key, item]) => (
            <box flexDirection="row" gap={1}>
              <text
                flexShrink={0}
                style={{
                  fg: (
                    {
                      connected: theme.success,
                      failed: theme.error,
                      disabled: theme.textMuted,
                      needs_auth: theme.warning,
                      needs_client_registration: theme.error,
                    } as Record<string, typeof theme.success>
                  )[item.status],
                }}
              >
                •
              </text>
              <text fg={theme.text} wrapMode="word">
                <b>{key}</b>{" "}
                <span style={{ fg: theme.textMuted }}>
                  <Switch fallback={item.status}>
                    <Match when={item.status === "connected"}>Connected</Match>
                    <Match when={item.status === "failed" && item}>{(val) => val().error}</Match>
                    <Match when={item.status === "disabled"}>Disabled in configuration</Match>
                    <Match when={(item.status as string) === "needs_auth"}>
                      Needs authentication (run: opencode mcp auth {key})
                    </Match>
                    <Match when={(item.status as string) === "needs_client_registration" && item}>
                      {(val) => (val() as { error: string }).error}
                    </Match>
                  </Switch>
                </span>
              </text>
            </box>
          )}
        </For>
      </Capability>
      <Capability
        unreadable={sync.data.unreadable.lsp}
        label="LSP Servers"
        empty="No LSP Servers"
        count={sync.data.lsp.length}
      >
        <For each={sync.data.lsp}>
          {(item) => (
            <box flexDirection="row" gap={1}>
              <text
                flexShrink={0}
                style={{
                  fg: {
                    connected: theme.success,
                    error: theme.error,
                  }[item.status],
                }}
              >
                •
              </text>
              <text fg={theme.text} wrapMode="word">
                <b>{item.id}</b> <span style={{ fg: theme.textMuted }}>{item.root}</span>
              </text>
            </box>
          )}
        </For>
      </Capability>
      <Capability
        unreadable={sync.data.unreadable.formatter}
        label="Formatters"
        empty="No Formatters"
        count={enabledFormatters().length}
      >
        <For each={enabledFormatters()}>
          {(item) => (
            <box flexDirection="row" gap={1}>
              <text
                flexShrink={0}
                style={{
                  fg: theme.success,
                }}
              >
                •
              </text>
              <text wrapMode="word" fg={theme.text}>
                <b>{item.name}</b>
              </text>
            </box>
          )}
        </For>
      </Capability>
      <Show when={plugins().length > 0} fallback={<text fg={theme.text}>No Plugins</text>}>
        <box>
          <text fg={theme.text}>{plugins().length} Plugins</text>
          <For each={plugins()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: theme.success,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={theme.text}>
                  <b>{item.name}</b>
                  {item.version && <span style={{ fg: theme.textMuted }}> @{item.version}</span>}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <UnreadableReads />
    </box>
  )
}
