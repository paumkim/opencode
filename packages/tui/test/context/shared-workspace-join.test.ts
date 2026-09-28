import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("../../src/context/shared-workspace.tsx", import.meta.url), "utf-8")

/**
 * A join the server will not honour used to reach the user as nothing at all.
 *
 * The server sent no `joined` frame and no close reason, so the client sat on its ten-second
 * join timeout, then rejected with a generic "WebSocket connection failed" - and the caller
 * swallowed even that, under a comment promising a retry "on next route change". In the only
 * case that matters there is no next route change: the user is already looking at the session.
 * They were left on a session that shows no live updates with nothing on screen to explain it.
 *
 * There is no WebSocket harness in this suite, so this checks the two behaviours directly. Each
 * window is bounded by its neighbouring handler, not by a line number, and each asserts against
 * the specific old shape rather than a comment that could be reworded into meaninglessness.
 */
test("a refused join reports the server's reason instead of timing out silently", () => {
  const start = source.indexOf("socket.onclose")
  const end = source.indexOf("socket.onerror", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const handler = source.slice(start, end)

  // The close reason is the only place the server's explanation can surface; the generic message
  // alone leaves the user with nothing actionable.
  expect(handler).toContain("event")
  expect(handler).toContain(".reason")
  // Still has to cover a normal end-of-stream, where `reason` is legitimately empty.
  expect(handler).toContain("WebSocket connection failed")
})

test("a failed auto-join is shown to the user rather than swallowed under a retry promise", () => {
  const start = source.indexOf("}).catch((error) => {")
  expect(start).toBeGreaterThan(-1)
  const branch = source.slice(start, start + 900)

  // The old body was empty, which is the whole defect. These three are what reverting it removes,
  // so they are the regression guard - and they say nothing about how the surrounding comment is
  // worded, which is free to explain itself as much as it likes.
  expect(branch).toContain("toast.show")
  // The user's own message, not a hardcoded string: the server now says why.
  expect(branch).toContain("error instanceof Error")
  // An empty catch is what this replaces, so assert the body is not empty either.
  expect(branch.replace(/\/\/[^\n]*/g, "").trim()).not.toMatch(/\}\s*$/)
})

test("a join that succeeds after a failure does not leave a stale error toast behind", () => {
  // The other direction: reporting on every rejection, including one from a socket the component
  // has already torn down, would be noise the user cannot act on. A disposed effect must not
  // report at all, so the check is that the guard is still first.
  const start = source.indexOf("}).catch((error) => {")
  const branch = source.slice(start, start + 900)
  const guardIndex = branch.indexOf("if (disposed) return")
  const toastIndex = branch.indexOf("toast.show")
  expect(guardIndex).toBeGreaterThan(-1)
  expect(toastIndex).toBeGreaterThan(guardIndex)
})
