/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait } from "./sync-fixture"

const KV = "kv.json"

/** Polls an async condition; the fixture's `wait` is synchronous. */
async function waitFor(fn: () => Promise<boolean>, timeout = 2000) {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

/** Reads the store, treating "not written yet" as an empty object so a poll does not throw. */
async function readKv(dir: string): Promise<Record<string, unknown>> {
  try {
    return (await Bun.file(path.join(dir, KV)).json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

describe("tui kv with an unreadable store", () => {
  test("a write that could not read the file is refused rather than erasing it", async () => {
    // The defect. `readJson` rejects, `setStore` never runs, so the store stays as the empty object
    // `createStore()` produced - indistinguishable from a genuinely empty store. The first `set` then
    // snapshotted that empty object and wrote it over the file, so one transient error at startup -
    // a permission problem, a full disk - cost the user every key the moment anything was written.
    // The write reported nothing either: it succeeded.
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, KV)
    await Bun.write(file, JSON.stringify({ layout: "wide", theme: "dark" }))

    // A directory where the file should be: reads fail, and it is emphatically not "does not exist".
    await fs.rm(file)
    await fs.mkdir(file)

    const errors: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "))
    }

    try {
      const { app, kv } = await mount(undefined, tmp.path)
      await wait(() => kv.ready)
      kv.set("layout", "narrow")
      app.renderer.destroy()
    } finally {
      console.error = original
    }

    // The file is untouched - still a directory, so "untouched" is literally checkable.
    expect((await fs.stat(file)).isDirectory()).toBe(true)
    // And the refusal is on the record, naming what would have been lost and why.
    const refusal = errors.find((line) => line.includes("Refusing to write"))
    expect(refusal).toBeDefined()
    expect(refusal).toContain("layout")
    expect(refusal).toContain("erase its existing contents")
  })

  test("the in-memory value is not changed either, so the UI and the file cannot disagree", async () => {
    // The choice worth stating: applying the change in memory and dropping the write would leave the
    // UI claiming a layout the file does not have, and on the next successful write that phantom value
    // would be persisted. Refusing both keeps the two in agreement.
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, KV)
    await fs.mkdir(file)

    const original = console.error
    console.error = () => {}
    try {
      const { app, kv } = await mount(undefined, tmp.path)
      await wait(() => kv.ready)
      kv.set("theme", "light")
      expect(kv.get("theme", "unset")).toBe("unset")
    } finally {
      console.error = original
    }
  })

  test("a normal load still writes, and still persists what it read", async () => {
    // The direction that must not regress. If this broke, every preference in the TUI would stop
    // being saved, which is a far worse bug than the one being fixed.
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, KV), JSON.stringify({ layout: "wide" }))

    const { app, kv } = await mount(undefined, tmp.path)
    try {
      await wait(() => kv.ready)
      expect(kv.get("layout")).toBe("wide")
      kv.set("layout", "narrow")
      await waitFor(async () => (await readKv(tmp.path)).layout === "narrow")
      expect(await readKv(tmp.path)).toEqual({ layout: "narrow" })
    } finally {
      app.renderer.destroy()
    }
  })

  test("an absent file is a first run, and writes work immediately", async () => {
    // The distinction the fix must not blur: no file at all means nothing to lose, so refusing there
    // would make it impossible to persist anything on a clean install.
    await using tmp = await tmpdir()
    const { app, kv } = await mount(undefined, tmp.path)
    try {
      await wait(() => kv.ready)
      kv.set("first", 1)
      await waitFor(async () => (await readKv(tmp.path)).first === 1)
      expect((await readKv(tmp.path)).first).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })
})
