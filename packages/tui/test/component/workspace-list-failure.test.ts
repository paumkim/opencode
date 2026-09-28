import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

/** Comments are stripped before asserting, so a `not.toMatch` cannot be satisfied by the prose
 * explaining the fix. An assertion about code runs on code. */
const strip = (file: string) =>
  readFileSync(new URL(`../../src/component/${file}`, import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n")

/**
 * Both `syncList()` call sites swallowed the failure, so a workspace list the server could not
 * return rendered as an empty picker. The user opens the workspace dialog, sees nothing, and the
 * only reading available is that they have no workspaces - which is a different situation with a
 * different response.
 *
 * The contrast is what makes this worth fixing rather than tidying: `remove()` in the list dialog
 * and `loadWorkspaceAdapters` in the create dialog both toast on failure, one line or three away
 * from a read that says nothing. The list read was the single silent hole next to code that
 * reports the same class of error.
 */
test("both workspace list refreshes report a failure instead of leaving an empty picker", () => {
  for (const file of ["dialog-workspace-list.tsx", "dialog-workspace-create.tsx"]) {
    const code = strip(file)
    const call = code.indexOf("syncList()")
    expect(call).toBeGreaterThan(-1)
    // The catch has to be attached to this call, not merely exist somewhere in the file - both of
    // these files have other, correctly-reporting catches, so a file-wide search would prove
    // nothing.
    const window = code.slice(Math.max(0, call - 120), call + 200)
    expect(window).not.toContain(".catch(() => undefined)")
    expect(window).toContain("toast.show")
  }
})

test("the picker says the list may be incomplete when the read failed, and nothing when it did not", () => {
  // Recording a reason is only half the fix - the picker has to show it. The mount-time toast
  // covers the open that failed; this covers the one that did not, where a reason recorded on an
  // earlier open is still sitting in the store and the list is quietly short.
  const code = strip("dialog-workspace-list.tsx")
  const footer = code.indexOf("footer=")
  expect(footer).toBeGreaterThan(-1)
  const window = code.slice(footer, footer + 200)
  expect(window).toContain("staleness()")
  expect(window).toContain("theme.warning")

  // And it reads the two keys the store now keeps, rather than the whole record.
  expect(code).toContain("project.data.unreadable.workspaceList")
  expect(code).toContain("project.data.unreadable.workspaceStatus")
  // The two are different failures: a missing list and a stale status dot are not the same warning.
  expect(code).toContain("This list may be incomplete:")
  expect(code).toContain("Connection status may be out of date:")
})
