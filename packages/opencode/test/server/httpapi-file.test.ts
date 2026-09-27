import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, query?: Record<string, string>) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return HttpApiApp.webHandler().handler(
    new Request(url, {
      headers: {
        "x-opencode-directory": directory,
      },
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("file HttpApi", () => {
  test("serves read endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const [list, content, status] = await Promise.all([
      request(FilePaths.list, tmp.path, { path: "." }),
      request(FilePaths.content, tmp.path, { path: "hello.txt" }),
      request(FilePaths.status, tmp.path),
    ])

    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(
      expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
    )

    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ type: "text", content: "hello" })

    expect(status.status).toBe(200)
    expect(await status.json()).toEqual([])
  })

  test("derives the ignored flag from the project ignore files", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, ".gitignore"), "secret.txt\n")
    await Bun.write(path.join(tmp.path, ".ignore"), "scratch.txt\n")
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")
    await Bun.write(path.join(tmp.path, "secret.txt"), "shh")
    await Bun.write(path.join(tmp.path, "scratch.txt"), "tmp")

    const list = await request(FilePaths.list, tmp.path, { path: "." })
    const body = (await list.json()) as Array<{ name: string; ignored: boolean }>
    const ignored = Object.fromEntries(body.map((item) => [item.name, item.ignored]))

    // Both ignore files are read and both branches of the derivation are exercised: the app
    // renders the flag and dims ignored entries, and no server test asserted it before this.
    expect(list.status).toBe(200)
    expect(ignored).toMatchObject({ "hello.txt": false, "secret.txt": true, "scratch.txt": true })
  })

  test("derives the ignored flag relative to the project root, not the instance directory", async () => {
    await using tmp = await tmpdir({ git: true })
    // An anchored pattern only matches when the path handed to `ignore` is project-relative, so
    // this pins the base of `path.relative(location.project.directory, ...)`: run the instance
    // from a subdirectory and "sub/secret.txt" matches "/sub/secret.txt" while a location-relative
    // "secret.txt" would not match it.
    await Bun.write(path.join(tmp.path, ".gitignore"), "/sub/secret.txt\n")
    const sub = path.join(tmp.path, "sub")
    await fs.mkdir(sub)
    await Bun.write(path.join(sub, "secret.txt"), "shh")
    await Bun.write(path.join(sub, "hello.txt"), "hello")

    const list = await request(FilePaths.list, sub, { path: "." })
    const body = (await list.json()) as Array<{ name: string; ignored: boolean }>

    expect(list.status).toBe(200)
    expect(body).toContainEqual(expect.objectContaining({ name: "secret.txt", ignored: true }))
    expect(body).toContainEqual(expect.objectContaining({ name: "hello.txt", ignored: false }))
  })

  test("lists through a symlinked instance directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, ".gitignore"), "secret.txt\n")
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")
    await Bun.write(path.join(tmp.path, "secret.txt"), "shh")

    // The instance directory is reached through a symlink, the way a user who keeps their
    // checkouts somewhere else (`~/projects/awesome -> /mnt/data/awesome`) always runs it.
    // `InstanceStore.load` canonicalizes with `FSUtil.resolve`, so the handler's two bases stay
    // in agreement; `ignore` throws a RangeError on a `..`-leading path, so this pins the
    // canonicalization at the boundary rather than after the fact in the handler.
    const link = path.join(os.tmpdir(), "opencode-test-link-" + Math.random().toString(36).slice(2))
    await fs.symlink(tmp.path, link)
    try {
      const list = await request(FilePaths.list, link, { path: "." })
      const body = (await list.json()) as Array<{ name: string; ignored: boolean }>

      expect(list.status).toBe(200)
      expect(body).toContainEqual(expect.objectContaining({ name: "hello.txt", ignored: false }))
      expect(body).toContainEqual(expect.objectContaining({ name: "secret.txt", ignored: true }))
    } finally {
      await fs.rm(link, { force: true })
    }
  })

  test("serves search endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "needle")

    const [text, symbols] = await Promise.all([
      request(FilePaths.findText, tmp.path, { pattern: "needle" }),
      request(FilePaths.findSymbol, tmp.path, { query: "hello" }),
    ])
    const files = await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const response = await request(FilePaths.findFile, tmp.path, { query: "hello", type: "file" })
          const body = await response.json()
          return body.includes("hello.txt") ? { response, body } : undefined
        }),
        "file search index was not ready",
      ),
    )

    expect(text.status).toBe(200)
    expect(await text.json()).toContainEqual(expect.objectContaining({ line_number: 1 }))

    expect(files.response.status).toBe(200)
    expect(files.body).toContain("hello.txt")

    expect(symbols.status).toBe(200)
    expect(await symbols.json()).toEqual([])
  })
})
