/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mount, wait, json, directory } from "../cli/cmd/tui/sync-fixture"
import type { FetchHandler } from "../fixture/tui-sdk"

/**
 * `syncWorkspace` already preserved the previous list when `workspace.list()` or
 * `workspace.status()` failed, which is the right instinct and protects an in-progress list. It
 * recorded nothing, though, and `project.data.unreadable` was a single slot covering only the
 * project read - so on a *first* run the preserved list is empty, and the workspace picker shows an
 * empty list that cannot be told from "you have no workspaces".
 *
 * The fix follows the shape `sync.tsx` already uses for the same problem: a key per read, a reason
 * string when the read failed, and absent when it succeeded. `sync.bootstrap` drives this, so the
 * test goes through the real mount rather than a source check.
 */
test("a failed workspace list read is recorded rather than presenting as no workspaces", async () => {
  const override: FetchHandler = (url) => {
    if (!url.pathname.endsWith("/experimental/workspace")) return undefined
    return json(
      { name: "InstanceLoadError", data: { message: "workspace list unavailable", directory } },
      { status: 500 },
    )
  }
  const { app, project } = await mount(override)
  try {
    await wait(() => project.data.unreadable.workspaceList !== undefined)
    // The reason, not just the fact: "unavailable" leaves the user with nothing to act on.
    expect(project.data.unreadable.workspaceList).toContain("workspace list unavailable")
  } finally {
    app.renderer.destroy()
  }
})

test("a healthy workspace list is not left marked unreadable", async () => {
  // The other direction, and the one a record-only fix would break. A stale reason left in the
  // store from a previous failure would make every later healthy list read look broken.
  const { app, sync, project } = await mount(undefined)
  try {
    await wait(() => sync.status === "complete" || sync.status === "partial")
    expect(project.data.unreadable.workspaceList).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})
