import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The stop-the-agent action was `void sdk.client.session.abort(...)` followed by
 * `setStore("interrupt", 0)`. The generated client resolves typed HTTP failures through `.error` instead
 * of rejecting, so that promise resolved and nothing happened: the user's explicit request to stop was
 * discarded, the counter reset so the UI looked idle again, and the agent kept running and billing with
 * no report anywhere.
 *
 * `mutateRemote` is what makes the refusal observable, and it has its own tests. What is not covered
 * there is this call site using it, so that is what this checks. The full `Prompt` component cannot be
 * mounted for this - it sits behind eleven context providers, and units 33 and 35 both found that
 * destabilising a shared fixture to reach one branch is the wrong trade.
 *
 * The window is the whole double-interrupt branch. My first version started the window at the
 * `session.abort` call, which is *nested inside* `mutateRemote(...)` - so the slice could not contain
 * the helper's own name and the test failed for a reason that had nothing to do with the code. The
 * branch is the real unit of behaviour anyway.
 */
test("the interrupt action reports a refused abort instead of resetting as though it worked", () => {
  const source = readFileSync(join(import.meta.dir, "../../src/component/prompt/index.tsx"), "utf8")
  const start = source.indexOf("if (store.interrupt >= 2) {")
  expect(start).toBeGreaterThan(-1)
  const window = source.slice(start, source.indexOf("dialog.clear()", start))

  // The refusal is reported, with the reason the server gave.
  expect(window).toContain("mutateRemote")
  expect(window).toContain("Could not stop the session")
  // And the counter is only reset when the server actually accepted the abort, so a retry is one tap
  // rather than a five-second wait.
  expect(window).toContain("if (stopped)")
})

test("the abort is not fired through a bare void", () => {
  // A narrower check than the one above on purpose: this is the exact line the defect was, and it is
  // what a future edit could reintroduce while leaving the reporting intact.
  const source = readFileSync(join(import.meta.dir, "../../src/component/prompt/index.tsx"), "utf8")
  expect(source).not.toContain("void sdk.client.session.abort(")
})
