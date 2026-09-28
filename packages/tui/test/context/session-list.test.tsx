/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mount, wait, json, directory, worktree } from "../cli/cmd/tui/sync-fixture"
import type { FetchHandler } from "../fixture/tui-sdk"

function session(id: string) {
  return {
    id,
    title: `Session ${id}`,
    projectID: "proj_test",
    directory,
    version: "test",
    time: { created: 1, updated: 1 },
  }
}

// `listSessions` ended in `x.data ?? []`, so a failed `session.list` resolved to
// an empty array rather than signalling anything. Every caller then wrote that
// array into the store, which is what the user is looking at: the session list
// came back empty, indistinguishable from "you have no sessions". For someone
// with real work in that project that reads as data loss, and the two callers
// are both user-facing — bootstrap, and an explicit refresh after toggling the
// directory filter.
const sessions = [session("ses_one"), session("ses_two")]

test("a successful session list populates the store", async () => {
  const { app, sync } = await mount(undefined)
  try {
    await wait(() => sync.status === "complete")
    expect(sync.data.session).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("a failed session refresh keeps the sessions already known", async () => {
  let calls = 0
  const override: FetchHandler = (url) => {
    if (url.pathname !== "/session") return undefined
    calls++
    // Bootstrap succeeds so the store is populated; the explicit refresh the
    // user triggers afterwards is the one that fails.
    if (calls === 1) return json(sessions)
    return json(
      { name: "InstanceLoadError", data: { message: "session list unavailable", directory } },
      { status: 500 },
    )
  }
  const { app, sync } = await mount(override)
  try {
    await wait(() => sync.data.session.length === 2)
    await sync.session.refresh()
    // The read failed, so the two sessions the server told us about are still
    // there and the reason is recorded rather than rendered as an empty list.
    expect(sync.data.session.map((item) => item.id)).toEqual(["ses_one", "ses_two"])
    expect(sync.data.unreadable.session).toContain("session list unavailable")
  } finally {
    app.renderer.destroy()
  }
})

test("a later successful refresh clears the recorded failure", async () => {
  let fail = false
  const override: FetchHandler = (url) => {
    if (url.pathname !== "/session") return undefined
    if (fail) return json({ name: "InstanceLoadError", data: { message: "transient" } }, { status: 500 })
    return json(sessions)
  }
  const { app, sync } = await mount(override)
  try {
    await wait(() => sync.data.session.length === 2)
    fail = true
    await sync.session.refresh()
    await wait(() => sync.data.unreadable.session !== undefined)
    fail = false
    await sync.session.refresh()
    expect(sync.data.unreadable.session).toBeUndefined()
    expect(sync.data.session.length).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})

// Bootstrap goes through the same read, so a failure there must not leave the
// TUI claiming the project has no sessions before the user has done anything.
test("a failed bootstrap session list does not invent an empty project", async () => {
  const override: FetchHandler = (url) => {
    if (url.pathname === "/session") {
      return json({ name: "InstanceLoadError", data: { message: "cannot list", directory } }, { status: 500 })
    }
    return undefined
  }
  const { app, sync } = await mount(override)
  try {
    await wait(() => sync.status === "complete")
    expect(sync.data.session).toEqual([])
    expect(sync.data.unreadable.session).toContain("cannot list")
  } finally {
    app.renderer.destroy()
  }
})
