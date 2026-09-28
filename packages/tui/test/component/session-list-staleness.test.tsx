/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { createStore } from "solid-js/store"
import { SessionListStaleness } from "../../src/component/dialog-session-list"

const sync = await import("../../src/context/sync")
const project = await import("../../src/context/project")
const theme = await import("../../src/context/theme")

/**
 * Both reads behind the session list are recorded when they fail — the
 * `session.list` read in sync, and the project/path read the list is scoped to.
 * Before this, neither was shown anywhere, so a list left stale by a blip was
 * indistinguishable from a complete one, and a session the user was looking for
 * could be missing with nothing on screen saying why.
 */
async function render(input: { session?: string; project?: string }) {
  const color = RGBA.fromHex("#ffffff")
  const [data] = createStore({
    unreadable: { session: input.session } as { session?: string },
  })
  // `project.data.unreadable` is a key per read since the workspace reads joined it, so the project
  // read is addressed by its own key rather than being the whole record.
  const [projectData] = createStore({ unreadable: { project: input.project } })
  const mocks = [
    spyOn(sync, "useSync").mockReturnValue({ data } as unknown as ReturnType<typeof sync.useSync>),
    spyOn(project, "useProject").mockReturnValue({
      data: projectData,
    } as unknown as ReturnType<typeof project.useProject>),
    spyOn(theme, "useTheme").mockReturnValue({
      theme: { warning: RGBA.fromHex("#ffcc00") },
    } as unknown as ReturnType<typeof theme.useTheme>),
  ]
  let app: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    app = await testRender(() => <SessionListStaleness />, { width: 100, height: 4 })
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app?.renderer.destroy()
    for (const mock of mocks) mock.mockRestore()
  }
}

test("says nothing when both reads succeeded", async () => {
  const text = await render({})
  expect(text.trim()).toBe("")
})

test("a failed session.list read marks the list as possibly out of date", async () => {
  const text = await render({ session: "connection refused" })
  expect(text).toContain("Session list may be out of date: connection refused")
})

test("a failed project read marks the list as possibly incomplete", async () => {
  const text = await render({ project: "instance load failed" })
  expect(text).toContain("Project could not be read, so this list may be incomplete: instance load failed")
})

// The session read is the more specific of the two, so it wins when both fail.
test("the session failure takes precedence when both reads failed", async () => {
  const text = await render({ session: "list failed", project: "project failed" })
  expect(text).toContain("list failed")
  expect(text).not.toContain("project failed")
})
