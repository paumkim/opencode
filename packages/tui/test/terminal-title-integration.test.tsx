import { expect, mock, test } from "bun:test"
import type { Event, Session } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

for (const disabled of [false, true]) {
  test(`app title effect consumes sync events and routes (disable flag: ${disabled})`, async () => {
    const state = await mkdtemp(join(tmpdir(), "opencode-title-"))
    await Bun.write(join(state, "kv.json"), JSON.stringify({ terminal_title_enabled: true }))
    const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
    const core = await import("@opentui/core")
    mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
    const previous = Flag.OPENCODE_DISABLE_TERMINAL_TITLE
    Flag.OPENCODE_DISABLE_TERMINAL_TITLE = disabled
    const titles: string[] = []
    setup.renderer.setTerminalTitle = (title) => {
      titles.push(title)
    }
    const events = createEventSource()
    const sessions: Session[] = ["parent", "child", "other"].map((id) => ({
      id,
      title: id === "parent" ? "Build status" : id,
      slug: id,
      projectID: "project",
      directory,
      version: "0.0.0-test",
      time: { created: 0, updated: 0 },
      ...(id === "child" ? { parentID: "parent" } : {}),
    }))
    const calls = createFetch((url) => {
      if (url.pathname === "/session") return json(sessions)
    })
    let api!: TuiPluginApi
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    // Keep route views unmounted: exercise the real App effect and SyncProvider,
    // without unrelated session-view API requests or terminal layout behavior.
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) {
            api = input.api
            started()
            await hold
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(Global.layerWith({ state }))),
    )

    async function settle() {
      await Bun.sleep(20)
      await setup.renderOnce()
    }
    async function title(expected: string) {
      for (let i = 0; i < 100 && titles.at(-1) !== expected; i++) await settle()
      expect(titles.at(-1)).toBe(expected)
    }
    async function emit(payload: Event) {
      events.emit({ directory, payload })
      await settle()
    }
    try {
      await ready
      await settle()
      api.route.navigate("session", { sessionID: "parent" })
      if (disabled) {
        await emit({
          id: crypto.randomUUID(),
          type: "session.status",
          properties: { sessionID: "parent", status: { type: "busy" } },
        })
        api.route.navigate("home")
        await settle()
        api.route.navigate("title-plugin")
        await settle()
        expect(titles).toEqual([])
        return
      }
      await title("OC | Build status")
      await emit({
        id: crypto.randomUUID(),
        type: "session.status",
        properties: { sessionID: "parent", status: { type: "busy" } },
      })
      await title("[~] OC | Build status")
      await emit({
        id: crypto.randomUUID(),
        type: "session.status",
        properties: { sessionID: "parent", status: { type: "retry", attempt: 1, message: "Retry", next: 0 } },
      })
      await title("[~] OC | Build status")
      await emit({
        id: crypto.randomUUID(),
        type: "permission.asked",
        properties: {
          id: "permission",
          sessionID: "child",
          permission: "read",
          patterns: ["*"],
          always: [],
          metadata: {},
        },
      })
      await title("[!] OC | Build status")
      await emit({
        id: crypto.randomUUID(),
        type: "question.asked",
        properties: { id: "question", sessionID: "child", questions: [] },
      })
      await emit({
        id: crypto.randomUUID(),
        type: "permission.replied",
        properties: { sessionID: "child", requestID: "permission", reply: "once" },
      })
      await title("[!] OC | Build status")
      await emit({
        id: crypto.randomUUID(),
        type: "question.rejected",
        properties: { sessionID: "child", requestID: "question" },
      })
      await title("[~] OC | Build status")
      await emit({
        id: crypto.randomUUID(),
        type: "session.status",
        properties: { sessionID: "parent", status: { type: "idle" } },
      })
      await title("[done] OC | Build status")
      api.route.navigate("session", { sessionID: "child" })
      await title("[done] OC | child")
      api.route.navigate("session", { sessionID: "other" })
      await title("OC | other")
      api.route.navigate("home")
      await title("OpenCode")
      await emit({
        id: crypto.randomUUID(),
        type: "session.status",
        properties: { sessionID: "other", status: { type: "busy" } },
      })
      await emit({
        id: crypto.randomUUID(),
        type: "session.status",
        properties: { sessionID: "other", status: { type: "idle" } },
      })
      api.route.navigate("session", { sessionID: "other" })
      await title("OC | other")
      api.keymap.dispatchCommand("terminal.title.toggle")
      await title("")
      await emit({
        id: crypto.randomUUID(),
        type: "session.status",
        properties: { sessionID: "other", status: { type: "busy" } },
      })
      await emit({
        id: crypto.randomUUID(),
        type: "session.status",
        properties: { sessionID: "other", status: { type: "idle" } },
      })
      api.keymap.dispatchCommand("terminal.title.toggle")
      await title("OC | other")
      await emit({
        id: crypto.randomUUID(),
        type: "question.asked",
        properties: { id: "other-question", sessionID: "other", questions: [] },
      })
      await title("[!] OC | other")
      await emit({
        id: crypto.randomUUID(),
        type: "question.replied",
        properties: { sessionID: "other", requestID: "other-question", answers: [] },
      })
      await title("[done] OC | other")
      api.route.navigate("title-plugin")
      await title("OC | title-plugin")
      api.route.navigate("session", { sessionID: "parent" })
      await title("[done] OC | Build status")
      await emit({
        id: crypto.randomUUID(),
        type: "session.updated",
        properties: { sessionID: "parent", info: { ...sessions[0], title: "x".repeat(41) } },
      })
      await title(`[done] OC | ${"x".repeat(37)}…`)
      await emit({
        id: crypto.randomUUID(),
        type: "session.updated",
        properties: { sessionID: "parent", info: { ...sessions[0], title: "New session - 2026-07-14T10:00:00.000Z" } },
      })
      await title("[done] OpenCode")
      api.keymap.dispatchCommand("terminal.title.toggle")
      await title("")
      const count = titles.length
      await emit({
        id: crypto.randomUUID(),
        type: "session.status",
        properties: { sessionID: "child", status: { type: "busy" } },
      })
      expect(titles.length).toBe(count)
      api.keymap.dispatchCommand("terminal.title.toggle")
      await title("[~] OpenCode")
      await emit({
        id: crypto.randomUUID(),
        type: "session.status",
        properties: { sessionID: "child", status: { type: "idle" } },
      })
      await title("[done] OpenCode")
      await emit({
        id: crypto.randomUUID(),
        type: "session.status",
        properties: { sessionID: "late-child", status: { type: "busy" } },
      })
      await title("[done] OpenCode")
      await emit({
        id: crypto.randomUUID(),
        type: "session.updated",
        properties: { sessionID: "late-child", info: { ...sessions[1], id: "late-child" } },
      })
      await title("[~] OpenCode")
      api.route.navigate("session", { sessionID: "missing" })
      await title("OpenCode")
    } finally {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      await task
      release()
      Flag.OPENCODE_DISABLE_TERMINAL_TITLE = previous
      mock.restore()
      await rm(state, { recursive: true, force: true })
    }
  }, 15000)
}
