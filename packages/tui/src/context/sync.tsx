import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
  SnapshotFileDiff,
  ConsoleState,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "./project"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useTuiStartup } from "./runtime"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onMount } from "solid-js"
import path from "path"
import { useKV } from "./kv"
import { usePermission } from "./permission"
import { useOptionalSharedWorkspace } from "./shared-workspace"
import { readRemote, type Read } from "../util/read-remote"
import { mutateRemote } from "../util/mutate-remote"
import { useToast } from "../ui/toast"

const emptyConsoleState: ConsoleState = {
  consoleManagedProviders: [],
  switchableOrgCount: 0,
}

function search<T>(items: T[], target: string, key: (item: T) => string) {
  let left = 0
  let right = items.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = key(items[middle])
    if (value === target) return { found: true, index: middle }
    if (value < target) left = middle + 1
    else right = middle - 1
  }
  return { found: false, index: left }
}

function compareMessage(a: Message, b: Message) {
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

const messageKey = (message: Message) => message.time.created + message.id

type SyncStore = {
  status: "loading" | "partial" | "complete"
  provider: Provider[]
  provider_default: Record<string, string>
  provider_next: ProviderListResponse
  console_state: ConsoleState
  capabilities: {
    experimentalBackgroundSubagents: boolean
  }
  provider_auth: Record<string, ProviderAuthMethod[]>
  agent: Agent[]
  command: Command[]
  permission: {
    [sessionID: string]: PermissionRequest[]
  }
  question: {
    [sessionID: string]: QuestionRequest[]
  }
  config: Config
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: SnapshotFileDiff[]
  }
  todo: {
    [sessionID: string]: Todo[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  lsp: LspStatus[]
  mcp: {
    [key: string]: McpStatus
  }
  mcp_resource: {
    [key: string]: McpResource
  }
  formatter: FormatterStatus[]
  vcs: VcsInfo | undefined
  /**
   * Which capability reads could not be completed, and why. A capability that
   * is absent from this record was genuinely empty; one present here is
   * *unknown*, and the UI must not claim it has none.
   */
  unreadable: {
    command?: string
    lsp?: string
    mcp?: string
    mcp_resource?: string
    formatter?: string
    session_status?: string
    provider_auth?: string
    vcs?: string
    session?: string
    capabilities?: string
    console_state?: string
  }
}

export const {
  context: SyncContext,
  use: useSync,
  provider: SyncProvider,
} = createSimpleContext({
  name: "Sync",
  init: () => {
    const startup = useTuiStartup()
    const kv = useKV()
    const permission = usePermission()
    const [store, setStore] = createStore<SyncStore>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      capabilities: {
        experimentalBackgroundSubagents: false,
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
      unreadable: {},
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()
    const sharedWs = useOptionalSharedWorkspace()
    const toast = useToast()

    const fullSyncedSessions = new Set<string>()
    const syncingSessions = new Map<string, Promise<void>>()
    const hydratingSessions = new Map<string, { messages: Set<string>; parts: Set<string> }>()
    const touchMessage = (sessionID: string, messageID: string) => {
      hydratingSessions.get(sessionID)?.messages.add(messageID)
    }
    const touchPart = (sessionID: string, partID: string) => {
      hydratingSessions.get(sessionID)?.parts.add(partID)
    }

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    // The session list is the one read where an empty answer is most damaging:
    // it used to be `x.data ?? []`, so a failed `session.list` resolved to "you
    // have no sessions" rather than "we could not ask". The user sees the list
    // they are working in empty out, which for a real project reads as lost work.
    // Return the outcome so callers can keep what they know.
    async function listSessions() {
      return readRemote(
        () => sdk.client.session.list({ start: Date.now() - 30 * 24 * 60 * 60 * 1000, ...sessionListQuery() }),
        [],
      )
    }

    /**
     * Writes a session-list outcome to the store. A failure records the reason
     * and leaves the known sessions alone; only a real answer replaces the list.
     */
    function applySessions(result: Read<Session[]>) {
      batch(() => {
        if (result.ok) {
          setStore("session", reconcile(result.data.toSorted((a, b) => a.id.localeCompare(b.id))))
          setStore("unreadable", "session", undefined)
          return
        }
        setStore("unreadable", "session", result.reason)
      })
    }

    /** Reads the session list and applies it, never replacing known sessions with a failure. */
    async function applySessionList() {
      applySessions(await listSessions())
    }

    event.subscribe((event, { directory, workspace }) => {
      switch (event.type) {
        case "server.instance.disposed":
          void bootstrap()
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          if (permission.mode === "auto") {
            if (sharedWs) {
              // The socket reconnects on route changes, so an auto-approve
              // written while it was down vanished into a bare `return` and the
              // agent sat blocked on a tool the user never saw asked for.
              if (!sharedWs.sendPermissionReply(request.sessionID, request.id, "once")) {
                toast.show({
                  variant: "error",
                  title: "Auto-approve failed",
                  message: "the shared workspace connection dropped the answer — the tool is waiting for you.",
                })
              }
            } else {
              // Auto-approve still deserves a voice when it fails: the agent is
              // blocked on a tool the user never sees asked for, and silence
              // here looks like a hung session rather than a refused answer.
              void mutateRemote(
                () =>
                  sdk.client.permission.reply({
                    requestID: request.id,
                    sessionID: request.sessionID,
                    reply: "once",
                    directory,
                    workspace,
                  }),
                (reason) =>
                  toast.show({
                    variant: "error",
                    title: "Auto-approve failed",
                    message: `${reason} — the tool is waiting for you.`,
                  }),
              )
            }
            break
          }
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.next.moved": {
          const result = search(store.session, event.properties.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.directory = event.properties.location.directory
              session.path = event.properties.subdirectory
              session.workspaceID = event.properties.location.workspaceID
              session.time.updated = event.properties.timestamp
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          touchMessage(event.properties.info.sessionID, event.properties.info.id)
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = search(messages, messageKey(event.properties.info), messageKey)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          touchMessage(event.properties.sessionID, event.properties.messageID)
          const messages = store.message[event.properties.sessionID]
          const index = messages.findIndex((message) => message.id === event.properties.messageID)
          if (index !== -1) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          touchPart(event.properties.part.sessionID, event.properties.part.id)
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = search(parts, event.properties.part.id, (part) => part.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = search(parts, event.properties.partID, (part) => part.id)
          if (!result.found) break
          touchPart(event.properties.sessionID, event.properties.partID)
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
               const field = event.properties.field as keyof typeof part
               const existing = (part[field] as string | undefined) ?? ""
               ;(part[field] as string) = existing + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          touchPart(event.properties.sessionID, event.properties.partID)
          const parts = store.part[event.properties.messageID]
          const result = search(parts, event.properties.partID, (part) => part.id)
          if (result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          // This is a push path, so it runs mid-session while the user is
          // working. It used to end in `x.data ?? []`, which made a failed
          // refresh — a blip, a server restart — indistinguishable from every
          // language server shutting down, and it emptied the list the user was
          // looking at. Keep the last known set and record the reason.
          void readRemote(() => sdk.client.lsp.status({ workspace }), []).then((result) => {
            if (result.ok) {
              setStore("lsp", reconcile(result.data))
              setStore("unreadable", "lsp", undefined)
              return
            }
            setStore("unreadable", "lsp", result.reason)
          })
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      // Recorded rather than swallowed. This used to end in `.catch(() => undefined)`, and the flag
      // below is computed as `capabilities?.backgroundSubagents === true` - so a read that never landed
      // was applied as a confident "this feature is off". Background subagents simply stopped
      // appearing, with nothing anywhere saying the server could not be asked. An unknown capability is
      // not the same as a disabled one, so the flag is only written from a read that succeeded.
      const capabilitiesPromise = readRemote<{ backgroundSubagents?: boolean }>(
        () => sdk.client.experimental.capabilities.get({ workspace }, { throwOnError: true }),
        {},
      )
      // Recorded rather than swallowed, for the same reason as `capabilities` above and with a sharper
      // consequence. This used to end in `.catch(() => emptyConsoleState)`, and `emptyConsoleState`
      // says no provider is console-managed and there is nothing to switch between. Both are claims the
      // user acts on: `dialog-provider` then offers an API-key path for a provider whose key is managed
      // centrally, drops the org name from its footer, and the "Switch org" command disappears from
      // app.tsx because `switchableOrgCount > 1` is false. None of it is recoverable by looking again -
      // the provider list simply looks like a local one.
      const consoleStatePromise = readRemote<ConsoleState>(
        () => sdk.client.experimental.console.get({ workspace }, { throwOnError: true }),
        emptyConsoleState,
      )
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      await Promise.all([
        providersPromise,
        providerListPromise,
        capabilitiesPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ])
        .then(async () => {
          const providersResponse = providersPromise.then((x) => x.data)
          const providerListResponse = providerListPromise.then((x) => x.data)
          const capabilitiesResponse = capabilitiesPromise
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            capabilitiesResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const capabilities = responses[2]
            const consoleState = responses[3]
            const agents = responses[4]
            const config = responses[5]
            const sessions = responses[6]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              // Only a read that landed may turn the flag on or off. On a failure the previous value is
              // left alone and the reason is recorded, so "we could not ask" is never applied as "off".
              if (capabilities.ok) {
                setStore(
                  "capabilities",
                  "experimentalBackgroundSubagents",
                  capabilities.data.backgroundSubagents === true,
                )
                setStore("unreadable", "capabilities", undefined)
              } else {
                setStore("unreadable", "capabilities", capabilities.reason)
              }
              // Only a read that landed may replace the known console state. On a failure the previous
              // value is left alone, so a transient error cannot turn a console-managed provider into
              // one that offers a local API key.
              if (consoleState.ok) {
                setStore("console_state", reconcile(consoleState.data))
                setStore("unreadable", "console_state", undefined)
              } else {
                setStore("unreadable", "console_state", consoleState.reason)
              }
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) applySessions(sessions)
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          // Each read below used to end in `x.data ?? []`, which made a server
          // that could not be reached indistinguishable from one that genuinely
          // has nothing configured. A failed `mcp.status` rendered as "No MCP
          // Servers" and a failed `command.list` as "no custom commands" — a
          // claim about the user's setup, drawn from a read that never landed.
          // `record` keeps the two apart so the UI can say "unknown" instead.
          const record = <K extends keyof SyncStore["unreadable"]>(key: K, result: Read<unknown>) => {
            batch(() => {
              if (result.ok) {
                setStore("unreadable", key, undefined)
                return
              }
              setStore("unreadable", key, result.reason)
            })
          }
          void Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then(applySessions)]),
            // Re-applied here as well as in the batch above, so the second pass follows the same rule:
            // apply only a read that landed, and record the one that did not.
            consoleStatePromise.then((x) => {
              if (x.ok) setStore("console_state", reconcile(x.data))
              record("console_state", x)
            }),
            readRemote(() => sdk.client.command.list({ workspace }), []).then((x) => {
              if (x.ok) setStore("command", reconcile(x.data))
              record("command", x)
            }),
            readRemote(() => sdk.client.lsp.status({ workspace }), []).then((x) => {
              if (x.ok) setStore("lsp", reconcile(x.data))
              record("lsp", x)
            }),
            readRemote(() => sdk.client.mcp.status({ workspace }), {}).then((x) => {
              if (x.ok) setStore("mcp", reconcile(x.data))
              record("mcp", x)
            }),
            readRemote(() => sdk.client.experimental.resource.list({ workspace }), {}).then((x) => {
              if (x.ok) setStore("mcp_resource", reconcile(x.data))
              record("mcp_resource", x)
            }),
            readRemote(() => sdk.client.formatter.status({ workspace }), []).then((x) => {
              if (x.ok) setStore("formatter", reconcile(x.data))
              record("formatter", x)
            }),
            readRemote(() => sdk.client.session.status({ workspace }), {}).then((x) => {
              if (x.ok) setStore("session_status", reconcile(x.data))
              record("session_status", x)
            }),
            readRemote(() => sdk.client.provider.auth({ workspace }), {}).then((x) => {
              if (x.ok) setStore("provider_auth", reconcile(x.data))
              record("provider_auth", x)
            }),
            readRemote(() => sdk.client.vcs.get({ workspace }), undefined).then((x) => {
              if (x.ok) setStore("vcs", reconcile(x.data))
              record("vcs", x)
            }),
            project.workspace.sync(),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          console.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) {
            exit(e)
          } else {
            throw e
          }
        })
    }

    onMount(() => {
      void bootstrap()
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (startup.skipInitialLoading) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          await applySessionList()
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) return
          const syncing = syncingSessions.get(sessionID)
          if (syncing) return syncing
          const tracker = { messages: new Set<string>(), parts: new Set<string>() }
          hydratingSessions.set(sessionID, tracker)
          const task = (async () => {
            const [session, messages, todo, diff] = await Promise.all([
              sdk.client.session.get({ sessionID }, { throwOnError: true }),
              readRemote(() => sdk.client.session.messages({ sessionID, limit: 100 }), []),
              readRemote(() => sdk.client.session.todo({ sessionID }), []),
              readRemote(() => sdk.client.session.diff({ sessionID }), []),
            ])
            setStore(
              produce((draft) => {
                const match = search(draft.session, sessionID, (s) => s.id)
                if (match.found) draft.session[match.index] = session.data!
                if (!match.found) draft.session.splice(match.index, 0, session.data)
                // These three reads carried no `throwOnError`, unlike the
                // `session.get` beside them, so each one fell through to `?? []`
                // and a failed read overwrote real content with an empty list.
                // A failed `messages` read was worse than an empty list: the
                // merge below keeps only what the live tracker has seen, so it
                // dropped every message loaded earlier and the `removed` loop
                // took their parts with it. A server blip mid-session shortened
                // the transcript. A failure now leaves what we already have.
                if (todo.ok) draft.todo[sessionID] = todo.data
                if (diff.ok) draft.session_diff[sessionID] = diff.data
                if (!messages.ok) return
                const currentMessages = draft.message[sessionID] ?? []
                const infos = messages.data.flatMap((message) => {
                  if (!tracker.messages.has(message.info.id)) return [message.info]
                  const current = currentMessages.find((item) => item.id === message.info.id)
                  return current ? [current] : []
                })
                infos.push(
                  ...currentMessages.filter(
                    (message) => tracker.messages.has(message.id) && !infos.some((item) => item.id === message.id),
                  ),
                )
                infos.sort(compareMessage)
                const removed = infos.slice(0, -100)
                const visible = infos.slice(-100)
                const visibleIDs = new Set(visible.map((message) => message.id))
                for (const message of messages.data) {
                  if (!visibleIDs.has(message.info.id)) {
                    delete draft.part[message.info.id]
                    continue
                  }
                  const currentParts = draft.part[message.info.id] ?? []
                  const parts = message.parts.flatMap((part) => {
                    const current = currentParts.find((item) => item.id === part.id)
                    if (tracker.parts.has(part.id)) return current ? [current] : []
                    if (
                      current &&
                      (part.type === "text" || part.type === "reasoning") &&
                      (current.type === "text" || current.type === "reasoning") &&
                      part.text.length === 0 &&
                      current.text.length > 0
                    ) {
                      return [current]
                    }
                    return [part]
                  })
                  parts.push(
                    ...currentParts.filter(
                      (part) => tracker.parts.has(part.id) && !parts.some((item) => item.id === part.id),
                    ),
                  )
                  draft.part[message.info.id] = parts
                }
                for (const message of removed) delete draft.part[message.id]
                draft.message[sessionID] = visible
              }),
            )
            // Only a session whose reads all landed counts as fully synced.
            // Marking it after a failure would make the gap permanent: the next
            // hydration would return early and never retry.
            if (messages.ok && todo.ok && diff.ok) fullSyncedSessions.add(sessionID)
          })().finally(() => {
            syncingSessions.delete(sessionID)
            hydratingSessions.delete(sessionID)
          })
          syncingSessions.set(sessionID, task)
          return task
        },
      },
      bootstrap,
    }
    return result
  },
})
