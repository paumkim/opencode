/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mount, wait, json, directory } from "../cli/cmd/tui/sync-fixture"
import type { FetchHandler } from "../fixture/tui-sdk"

/**
 * A failed `experimental.capabilities` read used to resolve to `undefined`, and the flag was computed
 * as `capabilities?.backgroundSubagents === true`. So a read that never landed was applied as a
 * confident "this feature is off": background subagents stopped appearing with nothing anywhere saying
 * the server could not be asked.
 *
 * An unknown capability is not a disabled one. The flag must only be written from a read that succeeded,
 * and the failure has to be recorded so the status dialog can name it.
 */
test("a failed capabilities read does not claim background subagents are disabled", async () => {
  const override: FetchHandler = (url) => {
    if (url.pathname !== "/experimental/capabilities") return undefined
    return json(
      { name: "InstanceLoadError", data: { message: "capabilities unavailable", directory } },
      { status: 500 },
    )
  }
  const { app, sync } = await mount(override)
  try {
    await wait(() => sync.status === "complete" || sync.status === "partial")
    // The failure is recorded with its reason, so the dialog can say the server could not be asked.
    expect(sync.data.unreadable.capabilities).toContain("capabilities unavailable")
  } finally {
    app.renderer.destroy()
  }
})

test("a successful capabilities read is not left marked unreadable", async () => {
  // The other direction, and the one a `record`-only fix would silently break: a healthy server must
  // not leave a stale reason in the store from a previous failure.
  const { app, sync } = await mount(undefined)
  try {
    await wait(() => sync.status === "complete" || sync.status === "partial")
    expect(sync.data.unreadable.capabilities).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("a failed re-read does not turn off a capability that was already known to be on", async () => {
  // This is the case that actually distinguishes the fix, and it is why the first test is not enough.
  // On a first load the flag reads false either way, because `undefined?.backgroundSubagents === true`
  // and "not yet written" are both false. The difference only appears when a working read is followed
  // by a failing one: the old code overwrote the known-true flag with false, so a single transient
  // 500 during a refresh silently disabled background subagents for the rest of the session.
  let calls = 0
  const override: FetchHandler = (url) => {
    if (url.pathname !== "/experimental/capabilities") return undefined
    calls++
    if (calls === 1) return json({ backgroundSubagents: true })
    return json(
      { name: "InstanceLoadError", data: { message: "capabilities unavailable", directory } },
      { status: 500 },
    )
  }
  const { app, sync } = await mount(override)
  try {
    await wait(() => sync.data.capabilities.experimentalBackgroundSubagents === true)
    expect(sync.data.unreadable.capabilities).toBeUndefined()

    await sync.bootstrap({ fatal: false })
    await wait(() => sync.data.unreadable.capabilities !== undefined)

    // Still on, because the last thing we actually read said it was on.
    expect(sync.data.capabilities.experimentalBackgroundSubagents).toBe(true)
    expect(sync.data.unreadable.capabilities).toContain("capabilities unavailable")
  } finally {
    app.renderer.destroy()
  }
})
