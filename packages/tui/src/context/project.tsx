import { batch } from "solid-js"
import type { Path, Workspace, WorkspaceEventConnectionStatus } from "@opencode-ai/sdk/v2"
import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { readRemote, type Read } from "../util/read-remote"

type WorkspaceStatus = "connected" | "connecting" | "disconnected" | "error"

/**
 * The identity of the project and directory this client is attached to.
 *
 * The generated SDK resolves a non-2xx as `{ data: undefined, error }` instead
 * of rejecting, and neither `/path` nor `/project/current` declares a 500 even
 * though both read through `InstanceContextMiddleware`, so a failed instance
 * load reaches the client as an ordinary response with no data.
 *
 * A failed read must therefore never be written as if it were an answer.
 * Writing it would replace a known-good worktree and project id with the
 * pre-read placeholders, and `instance.directory()` — which callers use as the
 * directory a session is created or moved into — would quietly become a
 * different directory than the one the user is in.
 */
type ProjectStore = {
  project: {
    id: string | undefined
    worktree: string | undefined
    mainDir: string | undefined
  }
  instance: {
    path: Path
  }
  workspace: {
    current: string | undefined
    list: Workspace[]
    status: Record<string, WorkspaceStatus>
  }
  /**
   * A key per read that could not be answered, set to the reason.
   *
   * A key that is absent was genuinely empty; one present here is *unknown*, and the UI must not
   * claim it has none. This is the same shape and the same reasoning as `sync.data.unreadable`.
   *
   * It used to be a single slot, which could only describe the project read. That was enough to
   * stop a failed `/path` or `/project/current` from being written as an answer, and not enough to
   * say anything about the workspace reads: `syncWorkspace` preserves the previous list on failure
   * but had nowhere to record that it had, so on a first run the preserved list is empty and the
   * workspace picker is indistinguishable from "you have no workspaces".
   */
  unreadable: {
    /** `/path` or `/project/current` - "this directory has no project" versus "we could not ask". */
    project?: string
    /** `workspace.list()` - the list the workspace picker offers. */
    workspaceList?: string
    /** `workspace.status()` - the per-workspace connection dots, and the home footer count. */
    workspaceStatus?: string
  }
}

export const { use: useProject, provider: ProjectProvider } = createSimpleContext({
  name: "Project",
  init: () => {
    const sdk = useSDK()

    const defaultPath = {
      home: "",
      state: "",
      config: "",
      worktree: "",
      directory: sdk.directory ?? "",
    } satisfies Path

    const [store, setStore] = createStore<ProjectStore>({
      project: {
        id: undefined,
        worktree: undefined,
        mainDir: undefined,
      },
      instance: {
        path: defaultPath,
      },
      workspace: {
        current: undefined,
        list: [],
        status: {},
      },
      unreadable: {} as ProjectStore["unreadable"],
    })

    async function sync() {
      const workspace = store.workspace.current
      const [instancePath, project] = await Promise.all([
        readRemote(() => sdk.client.path.get({ workspace }), defaultPath),
        readRemote(() => sdk.client.project.current({ workspace }), undefined),
      ])

      // Either read failing leaves the previous good state in place. Overwriting
      // it would be a guess dressed as an answer: a stale-but-real worktree is
      // recoverable, a fabricated one silently misroutes sessions.
      if (!instancePath.ok || !project.ok) {
        const reason = !instancePath.ok ? instancePath.reason : (project as { ok: false; reason: string }).reason
        batch(() => setStore("unreadable", "project", reason))
        return
      }

      // `project.current` answers with no `id` when the directory is not part of
      // a project. That is a real answer, so only then is `directories` worth
      // asking.
      const projectID = project.data?.id
      const directories = projectID
        ? await readRemote(() => sdk.client.project.directories({ projectID, workspace }), [])
        : undefined

      batch(() => {
        setStore("instance", "path", reconcile(instancePath.data))
        setStore("project", "id", project.data?.id)
        setStore("project", "worktree", project.data?.worktree)
        // A failed `directories` read leaves `mainDir` unknown rather than
        // inventing one. `dialog-move-session` uses it as the destination to
        // move a session back to.
        setStore(
          "project",
          "mainDir",
          directories?.ok ? directories.data.findLast((item) => item.strategy === undefined)?.directory : undefined,
        )
        setStore("unreadable", { ...store.unreadable, project: undefined })
      })
    }

    async function syncWorkspace() {
      const listed = await readRemote(() => sdk.client.experimental.workspace.list(), undefined)
      // No data means the list could not be read, which is not the same as
      // there being no workspaces. Bailing keeps the previous list.
      if (!listed.ok) {
        setStore("unreadable", "workspaceList", listed.reason)
        return
      }
      const status = await readRemote(
        () => sdk.client.experimental.workspace.status(),
        [] as WorkspaceEventConnectionStatus[],
      )
      // A failed status read must not blank the map: `workspace.status(id)`
      // returning undefined already means "unknown", but `{}` makes every
      // workspace look disconnected at once, and the home footer counts them.
      if (!status.ok) {
        setStore("unreadable", "workspaceStatus", status.reason)
        return
      }

      const next = Object.fromEntries(status.data.map((item) => [item.workspaceID, item.status]))

      batch(() => {
        setStore("unreadable", { ...store.unreadable, workspaceList: undefined, workspaceStatus: undefined })
        setStore("workspace", "list", reconcile(listed.data ?? []))
        setStore("workspace", "status", reconcile(next))
        if (!(listed.data ?? []).some((item) => item.id === store.workspace.current)) {
          setStore("workspace", "current", undefined)
        }
      })
    }

    sdk.event.on("event", (event) => {
      if (event.payload.type === "workspace.status") {
        setStore("workspace", "status", event.payload.properties.workspaceID, event.payload.properties.status)
      }
    })

    return {
      data: store,
      project() {
        return store.project.id
      },
      instance: {
        path() {
          return store.instance.path
        },
        directory() {
          return store.instance.path.directory
        },
      },
      workspace: {
        current() {
          return store.workspace.current
        },
        set(next?: string | null) {
          const workspace = next ?? undefined
          if (store.workspace.current === workspace) return
          setStore("workspace", "current", workspace)
        },
        list() {
          return store.workspace.list
        },
        get(workspaceID: string) {
          return store.workspace.list.find((item) => item.id === workspaceID)
        },
        status(workspaceID: string) {
          return store.workspace.status[workspaceID]
        },
        statuses() {
          return store.workspace.status
        },
        sync: syncWorkspace,
      },
      sync,
    }
  },
})
