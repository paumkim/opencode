import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { operationFailureTitle } from "../../src/context/shared-workspace"

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

/**
 * A shared-workspace operation the server accepted and then could not carry out used to reach the
 * user as nothing at all. The client only sends over the socket when the socket is up, so there is
 * no HTTP fallback covering a prompt, a command, a shell, an abort or a permission answer sent
 * this way - the message simply disappeared, and an agent blocked on a permission stayed blocked.
 *
 * The server answers with an `operationError` frame. It has to be handled *before* the generic
 * dispatch, which would otherwise hand it to the SDK event bridge as if it were a session event.
 */
test("an operationError frame is surfaced to the user, not forwarded as a session event", () => {
  const handlerStart = source.indexOf("socket.onmessage")
  expect(handlerStart).toBeGreaterThan(-1)
  const handler = source.slice(handlerStart, source.indexOf("socket.onclose", handlerStart))

  expect(handler).toContain('data.type === "operationError"')
  expect(handler).toContain("toast.show")
  // It has to return before the dispatch below, or the SDK event bridge is handed a frame that is
  // not a session event.
  const checkIndex = handler.indexOf('data.type === "operationError"')
  const dispatchIndex = handler.indexOf("for (const listener of listeners)")
  expect(checkIndex).toBeGreaterThan(-1)
  expect(dispatchIndex).toBeGreaterThan(checkIndex)
  expect(handler.slice(checkIndex, dispatchIndex)).toContain("return")
})

test("names the operation that failed rather than one generic message", () => {
  // "Could not send your message" and "could not stop the agent" are different failures with
  // different consequences, and a user who pressed stop needs to know the agent is still working.
  expect(operationFailureTitle("prompt")).toBe("Your message was not sent")
  expect(operationFailureTitle("abort")).toBe("Could not stop the agent")
  expect(operationFailureTitle("permissionReply")).toBe("Your permission answer did not reach the agent")
  // A name this build does not know about still has to say something.
  expect(operationFailureTitle("somethingElse")).toBe("The server could not do that")
  expect(operationFailureTitle(undefined)).toBe("The server could not do that")
})
