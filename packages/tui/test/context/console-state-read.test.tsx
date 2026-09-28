/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mount, wait, json, directory } from "../cli/cmd/tui/sync-fixture"
import type { FetchHandler } from "../fixture/tui-sdk"

/**
 * A failed `experimental.console` read used to resolve to `emptyConsoleState`, which says no provider
 * is console-managed and there is nothing to switch between. Both are claims the user acts on:
 * `dialog-provider` then offers an API-key path for a provider whose key is managed centrally and drops
 * the org name from its footer, and `app.tsx` drops the "Switch org" command because
 * `switchableOrgCount > 1` is false.
 *
 * So a transient 500 made a console-managed account look like a local one — and the reverse case is
 * worse, because a provider that IS managed would offer a local key the user should not be setting.
 */
test("a failed console read does not report the account as locally managed", async () => {
  const override: FetchHandler = (url) => {
    if (url.pathname !== "/experimental/console") return undefined
    return json(
      { name: "InstanceLoadError", data: { message: "console state unavailable", directory } },
      { status: 500 },
    )
  }
  const { app, sync } = await mount(override)
  try {
    await wait(() => sync.status === "complete" || sync.status === "partial")
    // The reason is recorded, so the status dialog can name it rather than the provider list quietly
    // looking local.
    expect(sync.data.unreadable.console_state).toContain("console state unavailable")
  } finally {
    app.renderer.destroy()
  }
})

test("a successful console read is not left marked unreadable", async () => {
  // The other direction: a record-only fix would leave a stale reason behind after a healthy server
  // answered, and the dialog would go on claiming the account is unknown.
  const { app, sync } = await mount(undefined)
  try {
    await wait(() => sync.status === "complete" || sync.status === "partial")
    expect(sync.data.unreadable.console_state).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("a failed re-read keeps a known console-managed provider managed", async () => {
  // The case that actually distinguishes the fix, and the reason a first-load test is not enough: with
  // one read saying "managed" and the next failing, the old code overwrote the known list with the empty
  // one, so the provider stopped being console-managed for the rest of the session and started offering
  // an API-key path it should not.
  let calls = 0
  const override: FetchHandler = (url) => {
    if (url.pathname !== "/experimental/console") return undefined
    calls++
    if (calls === 1) return json({ consoleManagedProviders: ["anthropic"], switchableOrgCount: 3 })
    return json(
      { name: "InstanceLoadError", data: { message: "console state unavailable", directory } },
      { status: 500 },
    )
  }
  const { app, sync } = await mount(override)
  try {
    await wait(() => sync.data.console_state.consoleManagedProviders.includes("anthropic"))
    expect(sync.data.unreadable.console_state).toBeUndefined()

    await sync.bootstrap({ fatal: false })
    await wait(() => sync.data.unreadable.console_state !== undefined)

    // Still managed, because the last thing we actually read said so.
    expect(sync.data.console_state.consoleManagedProviders).toEqual(["anthropic"])
    expect(sync.data.console_state.switchableOrgCount).toBe(3)
    expect(sync.data.unreadable.console_state).toContain("console state unavailable")
  } finally {
    app.renderer.destroy()
  }
})
