/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ProjectProvider, useProject } from "../../src/context/project"

const sdkContext = await import("../../src/context/sdk")

type Response = { data?: unknown; error?: unknown }

const goodPath = {
  home: "/home/u",
  state: "/home/u/.local/state",
  config: "/home/u/.config",
  worktree: "/repo",
  directory: "/repo/src",
}

const goodProject = { id: "prj_1", worktree: "/repo", vcs: "git" }

/**
 * Renders the real ProjectProvider against a fake SDK client and returns the
 * live context, so `sync()` and the store it writes are the real ones.
 */
async function mount(client: unknown) {
  let app: Awaited<ReturnType<typeof testRender>> | undefined
  let ctx: ReturnType<typeof useProject> | undefined
  const Probe = () => {
    ctx = useProject()
    return null
  }
  const mock = spyOn(sdkContext, "useSDK").mockReturnValue({
    directory: "/client/cwd",
    client,
    event: { on() {} },
  } as unknown as ReturnType<typeof sdkContext.useSDK>)
  try {
    app = await testRender(
      () => (
        <ProjectProvider>
          <Probe />
        </ProjectProvider>
      ),
      { width: 40, height: 6 },
    )
    await app.renderOnce()
    if (!ctx) throw new Error("project context was not provided")
    return { ctx, dispose: () => mock.mockRestore() }
  } finally {
    app?.renderer.destroy()
  }
}

function clientOf(overrides: { path?: Response; project?: Response; directories?: Response }) {
  return {
    path: { get: async () => overrides.path ?? { data: goodPath } },
    project: {
      current: async () => overrides.project ?? { data: goodProject },
      directories: async () => overrides.directories ?? { data: [] },
    },
    experimental: {
      workspace: {
        list: async () => ({ data: [] }),
        status: async () => ({ data: [] }),
      },
    },
  }
}

test("a good read populates the path and the project", async () => {
  const { ctx, dispose } = await mount(
    clientOf({
      directories: { data: [{ directory: "/repo", strategy: undefined }] },
    }),
  )
  try {
    await ctx.sync()
    expect(ctx.instance.path().worktree).toBe("/repo")
    expect(ctx.instance.directory()).toBe("/repo/src")
    expect(ctx.project()).toBe("prj_1")
    expect(ctx.data.project.mainDir).toBe("/repo")
    expect(ctx.data.unreadable).toBeUndefined()
  } finally {
    dispose()
  }
})

// The regression this pins. `/path` declares only a 400, and reads through
// InstanceContextMiddleware, so a failed instance load reaches the client as a
// 500 with no data. The old code wrote `instancePath.data || defaultPath` —
// turning the failure into `defaultPath.directory = sdk.directory`, a
// *truthy* directory that isn't the one the user is in. `sessionListQuery`
// then filtered the session list to a subdirectory of the wrong root, and
// `instance.directory()` became the directory a session is created into.
test("a failed path read does not invent a directory", async () => {
  const { ctx, dispose } = await mount(
    clientOf({ path: { data: undefined, error: { name: "InternalServerError", data: { message: "boom" } } } }),
  )
  try {
    await ctx.sync()
    expect(ctx.data.unreadable).toEqual({ ok: false, reason: "boom" })
    // The pre-read placeholder is all there is, and it must stay visibly
    // unconfirmed rather than being presented as an answer.
    expect(ctx.data.instance.path.directory).toBe("/client/cwd")
    expect(ctx.data.instance.path.worktree).toBe("")
  } finally {
    dispose()
  }
})

// The stronger half: once a real value is known, a later failed read must not
// destroy it. Losing a good worktree to a transient error is how a session ends
// up moved to a directory the user never chose.
test("a failed read after a good one keeps the known-good state", async () => {
  let fail = false
  const client = {
    path: {
      get: async () => (fail ? { data: undefined, error: { data: { message: "later boom" } } } : { data: goodPath }),
    },
    project: {
      current: async () =>
        fail ? { data: undefined, error: { data: { message: "later boom" } } } : { data: goodProject },
      directories: async () => ({ data: [{ directory: "/repo", strategy: undefined }] }),
    },
    experimental: {
      workspace: { list: async () => ({ data: [] }), status: async () => ({ data: [] }) },
    },
  }
  const { ctx, dispose } = await mount(client)
  try {
    await ctx.sync()
    expect(ctx.instance.directory()).toBe("/repo/src")
    expect(ctx.project()).toBe("prj_1")

    fail = true
    await ctx.sync()
    expect(ctx.data.unreadable).toEqual({ ok: false, reason: "later boom" })
    expect(ctx.instance.path().worktree).toBe("/repo")
    expect(ctx.instance.directory()).toBe("/repo/src")
    expect(ctx.project()).toBe("prj_1")
    expect(ctx.data.project.mainDir).toBe("/repo")
  } finally {
    dispose()
  }
})

test("a failed project.current read does not claim there is no project", async () => {
  const { ctx, dispose } = await mount(
    clientOf({ project: { data: undefined, error: { data: { message: "no instance" } } } }),
  )
  try {
    await ctx.sync()
    expect(ctx.data.unreadable).toEqual({ ok: false, reason: "no instance" })
    expect(ctx.data.project.id).toBeUndefined()
  } finally {
    dispose()
  }
})

// "This directory is not part of a project" is a real answer, not a failure, so
// it must not be reported as unreadable.
test("a directory with no project is a real answer, not a failure", async () => {
  const { ctx, dispose } = await mount(clientOf({ project: { data: { id: undefined, worktree: undefined } } }))
  try {
    await ctx.sync()
    expect(ctx.data.unreadable).toBeUndefined()
    expect(ctx.project()).toBeUndefined()
    expect(ctx.instance.path().worktree).toBe("/repo")
  } finally {
    dispose()
  }
})

test("a failed directories read leaves mainDir unknown rather than fabricated", async () => {
  const { ctx, dispose } = await mount(
    clientOf({ directories: { data: undefined, error: { data: { message: "dir read failed" } } } }),
  )
  try {
    await ctx.sync()
    expect(ctx.data.project.mainDir).toBeUndefined()
    // The rest of the sync still succeeded, so it is not marked unreadable.
    expect(ctx.data.unreadable).toBeUndefined()
  } finally {
    dispose()
  }
})
