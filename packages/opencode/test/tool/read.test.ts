import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Filesystem } from "@/util/filesystem"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const readLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      Instruction.node,
      LSP.node,
      Ripgrep.node,
      Truncate.node,
    ]),
  )

const it = testEffect(Layer.mergeAll(readLayer(), testInstanceStoreLayer))

const init = Effect.fn("ReadToolTest.init")(function* () {
  const info = yield* ReadTool
  return yield* info.init()
})

const run = Effect.fn("ReadToolTest.run")(function* (
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("ReadToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const fail = Effect.fn("ReadToolTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* exec(dir, args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected read to fail")
})

const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")
const githubBase = <A, E, R>(url: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = url
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous) process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = previous
        else delete process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      }),
  )
const git = Effect.fn("ReadToolTest.git")(function* (cwd: string, args: string[]) {
  return yield* Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`)
    return stdout.trim()
  })
})
const put = Effect.fn("ReadToolTest.put")(function* (p: string, content: string | Buffer | Uint8Array) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})
const load = Effect.fn("ReadToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})
const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    },
  }
}

describe("tool.read external_directory permission", () => {
  it.live("allows reading absolute path inside project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "test.txt"), "hello world")

      const result = yield* exec(dir, { filePath: path.join(dir, "test.txt") })
      expect(result.output).toContain("hello world")
    }),
  )

  it.live("allows reading file in subdirectory inside project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "test.txt"), "nested content")

      const result = yield* exec(dir, { filePath: path.join(dir, "subdir", "test.txt") })
      expect(result.output).toContain("nested content")
    }),
  )

  it.live("asks for external_directory permission when reading absolute path outside project", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "secret.txt"), "secret data")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(outer, "secret.txt") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "*")))
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes read permission paths on Windows", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* put(path.join(dir, "test.txt"), "hello world")

        const { items, next } = asks()
        const target = path.join(dir, "test.txt")
        const alt = target
          .replace(/^[A-Za-z]:/, "")
          .replaceAll("\\", "/")
          .toLowerCase()

        yield* exec(dir, { filePath: alt }, next)
        const read = items.find((item) => item.permission === "read")
        expect(read).toBeDefined()
        expect(read!.patterns).toEqual([path.relative(dir, full(target))])
      }),
    )
  }

  it.live("uses worktree-relative path for read permission so user rules match like edit/write", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(dir, "src", "secret.ts"), "shh")

      const { items, next } = asks()
      yield* exec(dir, { filePath: path.join(dir, "src", "secret.ts") }, next)
      const read = items.find((item) => item.permission === "read")
      expect(read).toBeDefined()
      expect(read!.patterns).toEqual([path.join("src", "secret.ts")])
    }),
  )

  it.live("asks for directory-scoped external_directory permission when reading external directory", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "external", "a.txt"), "a")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(outer, "external") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "external", "*")))
    }),
  )

  it.live("asks for external_directory permission when reading relative path outside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })

      const { items, next } = asks()

      yield* fail(dir, { filePath: "../outside.txt" }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
    }),
  )

  it.live("does not ask for external_directory permission when reading inside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(dir, "internal.txt"), "internal content")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(dir, "internal.txt") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeUndefined()
    }),
  )
})

describe("tool.read env file permissions", () => {
  const cases: [string, boolean][] = [
    [".env", true],
    [".env.local", true],
    [".env.production", true],
    [".env.development.local", true],
    [".env.example", false],
    [".envrc", false],
    ["environment.ts", false],
  ]

  for (const agentName of ["build", "plan"] as const) {
    describe(`agent=${agentName}`, () => {
      for (const [filename, shouldAsk] of cases) {
        it.live(`${filename} asks=${shouldAsk}`, () =>
          Effect.gen(function* () {
            const dir = yield* tmpdirScoped()
            yield* put(path.join(dir, filename), "content")

            const asked = yield* provideInstance(dir)(
              Effect.gen(function* () {
                const agent = yield* Agent.Service
                const info = yield* agent.get(agentName)
                let asked = false
                const next = {
                  ...ctx,
                  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
                    Effect.sync(() => {
                      for (const pattern of req.patterns) {
                        const rule = Permission.evaluate(req.permission, pattern, info.permission)
                        if (rule.action === "ask" && req.permission === "read") {
                          asked = true
                        }
                        if (rule.action === "deny") {
                          throw new PermissionV1.DeniedError({ ruleset: info.permission })
                        }
                      }
                    }),
                }

                yield* run({ filePath: path.join(dir, filename) }, next)
                return asked
              }),
            )

            expect(asked).toBe(shouldAsk)
          }),
        )
      }
    })
  }
})

describe("tool.read truncation", () => {
  for (const offset of [undefined, 2, 3]) {
    it.instance(`clamps zero file limit and advances pagination at offset ${offset ?? "default"}`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "lines.txt")
        yield* put(filepath, "first\nsecond\nthird")

        const result = yield* run({ filePath: filepath, limit: 0, offset })
        const start = offset ?? 1
        const text = ["first", "second", "third"][start - 1]
        expect(result.metadata.preview).toBe(text)
        expect(result.metadata.truncated).toBe(start < 3)
        expect(result.metadata.display).toEqual({
          type: "file",
          path: filepath,
          text,
          lineStart: start,
          lineEnd: start,
          totalLines: 3,
          truncated: start < 3,
        })
        expect(result.output).toContain(`${start}: ${text}`)
        expect(result.output).not.toContain(`${start + 1}:`)
        expect(result.output).toContain(
          start < 3
            ? `Showing lines ${start}-${start} of 3. Use offset=${start + 1} to continue.`
            : "End of file - total 3 lines",
        )
      }),
    )

    it.instance(`clamps zero directory limit and advances pagination at offset ${offset ?? "default"}`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "folder")
        yield* put(path.join(filepath, "a.txt"), "a")
        yield* put(path.join(filepath, "b.txt"), "b")
        yield* put(path.join(filepath, "c.txt"), "c")

        const result = yield* run({ filePath: filepath, limit: 0, offset })
        const start = offset ?? 1
        const entry = ["a.txt", "b.txt", "c.txt"][start - 1]
        expect(result.metadata.preview).toBe(entry)
        expect(result.metadata.truncated).toBe(start < 3)
        expect(result.metadata.display).toEqual({
          type: "directory",
          path: filepath,
          entries: [entry],
          offset: start,
          totalEntries: 3,
          truncated: start < 3,
        })
        expect(result.output).toContain(`<entries>\n${entry}\n`)
        expect(result.output).toContain(
          start < 3
            ? `Showing 1 of 3 entries. Use 'offset' parameter to read beyond entry ${start + 1}`
            : "(3 entries)",
        )
      }),
    )
  }

  it.instance("allows zero limit on an empty file but preserves offset validation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "empty.txt")
      yield* put(filepath, "")

      const result = yield* run({ filePath: filepath, limit: 0 })
      expect(result.metadata.preview).toBe("")
      expect(result.metadata.truncated).toBe(false)
      expect(result.metadata.display).toMatchObject({ text: "", lineStart: 1, lineEnd: 0, totalLines: 0 })
      expect(result.output).toContain("End of file - total 0 lines")
      expect(result.output).not.toContain("Use offset=")

      const err = yield* fail(test.directory, { filePath: filepath, limit: 0, offset: 2 })
      expect(err.message).toContain("Offset 2 is out of range for this file (0 lines)")
    }),
  )

  it.instance("allows zero limit on an empty directory without suggesting another page", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "empty")
      const fs = yield* FSUtil.Service
      yield* fs.makeDirectory(filepath)

      for (const offset of [undefined, 2]) {
        const result = yield* run({ filePath: filepath, limit: 0, offset })
        expect(result.metadata.preview).toBe("")
        expect(result.metadata.truncated).toBe(false)
        expect(result.metadata.display).toMatchObject({ entries: [], offset: offset ?? 1, totalEntries: 0 })
        expect(result.output).toContain("(0 entries)")
        expect(result.output).not.toContain("beyond entry")
      }
    }),
  )

  it.instance("truncates large file by bytes and sets truncated metadata", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const content = `${"x".repeat(80)}\n`.repeat(800)
      yield* put(path.join(test.directory, "large.json"), content)

      const result = yield* run({ filePath: path.join(test.directory, "large.json") })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Output capped at")
      expect(result.output).toContain("Use offset=")
    }),
  )

  it.instance("stops streaming after the byte cap", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "huge.txt")
      const content = `${"x".repeat(80)}\n`.repeat(50_000)
      yield* put(filepath, content)

      const fs = yield* FSUtil.Service
      const counter = { bytes: 0 }
      const result = yield* run({ filePath: filepath }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            stream: (file, options) =>
              fs.stream(file, options).pipe(
                Stream.tap((chunk) =>
                  Effect.sync(() => {
                    counter.bytes += chunk.length
                  }),
                ),
              ),
          }),
        ),
      )

      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Output capped at")
      expect(counter.bytes).toBeLessThan(Buffer.byteLength(content, "utf-8") / 2)
    }),
  )

  it.instance("truncates by line count when limit is specified", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      yield* put(path.join(test.directory, "many-lines.txt"), lines)

      const result = yield* run({ filePath: path.join(test.directory, "many-lines.txt"), limit: 10 })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Showing lines 1-10 of 100")
      expect(result.output).toContain("Use offset=11")
      expect(result.output).toContain("line0")
      expect(result.output).toContain("line9")
      expect(result.output).not.toContain("line10")
    }),
  )

  it.instance("does not truncate small file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* put(path.join(test.directory, "small.txt"), "hello world")

      const result = yield* run({ filePath: path.join(test.directory, "small.txt") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("End of file")
      expect(result.metadata.display).toMatchObject({
        type: "file",
        path: path.join(test.directory, "small.txt"),
        text: "hello world",
        lineStart: 1,
        lineEnd: 1,
        totalLines: 1,
        truncated: false,
      })
    }),
  )

  it.live("respects offset parameter", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "offset.txt"), lines)

      const result = yield* exec(dir, { filePath: path.join(dir, "offset.txt"), offset: 10, limit: 5 })
      expect(result.output).toContain("10: line10")
      expect(result.output).toContain("14: line14")
      expect(result.output).not.toContain("9: line10")
      expect(result.output).not.toContain("15: line15")
      expect(result.output).toContain("line10")
      expect(result.output).toContain("line14")
      expect(result.output).not.toContain("line0")
      expect(result.output).not.toContain("line15")
    }),
  )

  it.live("throws when offset is beyond end of file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 3 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "short.txt"), lines)

      const err = yield* fail(dir, { filePath: path.join(dir, "short.txt"), offset: 4, limit: 5 })
      expect(err.message).toContain("Offset 4 is out of range for this file (3 lines)")
    }),
  )

  it.live("allows reading empty file at default offset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const result = yield* exec(dir, { filePath: path.join(dir, "empty.txt") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("End of file - total 0 lines")
    }),
  )

  it.live("throws when offset > 1 for empty file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const err = yield* fail(dir, { filePath: path.join(dir, "empty.txt"), offset: 2 })
      expect(err.message).toContain("Offset 2 is out of range for this file (0 lines)")
    }),
  )

  it.live("does not mark final directory page as truncated", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.forEach(
        Array.from({ length: 10 }, (_, i) => i),
        (i) => put(path.join(dir, "dir", `file-${i + 1}.txt`), `line${i}`),
        {
          concurrency: "unbounded",
        },
      )

      const result = yield* exec(dir, { filePath: path.join(dir, "dir"), offset: 6, limit: 5 })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).not.toContain("Showing 5 of 10 entries")
      expect(result.metadata.display).toMatchObject({
        type: "directory",
        path: path.join(dir, "dir"),
        entries: ["file-5.txt", "file-6.txt", "file-7.txt", "file-8.txt", "file-9.txt"],
        offset: 6,
        totalEntries: 10,
        truncated: false,
      })
    }),
  )

  it.live("truncates long lines", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "long-line.txt"), "x".repeat(3000))

      const result = yield* exec(dir, { filePath: path.join(dir, "long-line.txt") })
      expect(result.output).toContain("(line truncated to 2000 chars)")
      expect(result.output.length).toBeLessThan(3000)
    }),
  )

  it.live("image files set truncated to false", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      )
      yield* put(path.join(dir, "image.png"), png)

      const result = yield* exec(dir, { filePath: path.join(dir, "image.png") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
    }),
  )

  it.live("detects attachment media from file contents", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
      yield* put(path.join(dir, "image.bin"), jpeg)

      const result = yield* exec(dir, { filePath: path.join(dir, "image.bin") })
      expect(result.output).toBe("Image read successfully")
      expect(result.attachments?.[0].mime).toBe("image/jpeg")
      expect(result.attachments?.[0].url.startsWith("data:image/jpeg;base64,")).toBe(true)
    }),
  )

  it.live("large image files are properly attached without error", () =>
    Effect.gen(function* () {
      const result = yield* exec(FIXTURES_DIR, { filePath: path.join(FIXTURES_DIR, "large-image.png") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0].type).toBe("file")
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
    }),
  )

  it.live(".fbs files (FlatBuffers schema) are read as text, not images", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fbs = `namespace MyGame;

table Monster {
  pos:Vec3;
  name:string;
  inventory:[ubyte];
}

root_type Monster;`
      yield* put(path.join(dir, "schema.fbs"), fbs)

      const result = yield* exec(dir, { filePath: path.join(dir, "schema.fbs") })
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain("namespace MyGame")
      expect(result.output).toContain("table Monster")
    }),
  )

  it.live("falls through unsupported image mime types to text", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const cases = [
        ["image.bmp", "BM text content"],
        ["photo.tiff", "II text content"],
        ["photo.avif", "avif text content"],
      ] as const

      for (const item of cases) {
        yield* put(path.join(dir, item[0]), item[1])
        const result = yield* exec(dir, { filePath: path.join(dir, item[0]) })
        expect(result.attachments).toBeUndefined()
        expect(result.output).toContain(item[1])
      }
    }),
  )
})

describe("tool.read notebooks", () => {
  for (const extension of ["ipynb", "IPYNB"]) {
    it.instance(`extracts ${extension} cell sources in order, excluding outputs and metadata`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, `analysis.${extension}`)
        yield* put(
          filepath,
          JSON.stringify({
            metadata: { secret: "hidden notebook metadata" },
            cells: [
              {
                cell_type: "markdown",
                source: ["# Analysis\n", "Introduction"],
                metadata: { secret: "hidden cell metadata" },
              },
              {
                cell_type: "code",
                source: "print('data only')\n",
                outputs: [{ text: "hidden output" }],
                execution_count: 42,
              },
              { cell_type: "markdown", source: "String markdown" },
              { cell_type: "code", source: ["x = 1\n", "print(x)"] },
              { cell_type: "raw", source: "hidden raw cell" },
              null,
              [],
              { cell_type: "code", source: ["invalid mixed array", 7] },
              { cell_type: "code", source: null, outputs: ["hidden invalid output"] },
              { cell_type: "markdown" },
            ],
          }),
        )
        const expected =
          "<markdown_cell>\n# Analysis\nIntroduction\n</markdown_cell>\n\n<code_cell>\nprint('data only')\n</code_cell>\n\n<markdown_cell>\nString markdown\n</markdown_cell>\n\n<code_cell>\nx = 1\nprint(x)\n</code_cell>"
        const result = yield* run({ filePath: filepath })
        expect(result.title.endsWith(`analysis.${extension}`)).toBe(true)
        expect(result.metadata.preview).toBe(expected)
        expect(result.metadata.display).toEqual({
          type: "file",
          path: filepath,
          text: expected,
          lineStart: 1,
          lineEnd: 17,
          totalLines: 17,
          truncated: false,
        })
        expect(result.metadata.loaded).toEqual([])
        expect(result.metadata.truncated).toBe(false)
        expect(result.attachments).toBeUndefined()
        expect(result.output).not.toContain("hidden")
        expect(result.output).not.toContain("invalid mixed array")
        expect(result.output).not.toContain("execution_count")
      }),
    )
  }

  for (const raw of ['{"cells":[', '{"metadata":{"name":"missing cells"}}', '{"cells":null}', "[]", "null", ""]) {
    it.instance(`falls back to raw text for invalid notebook structure ${JSON.stringify(raw)}`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "broken.ipynb")
        yield* put(filepath, raw)
        const result = yield* run({ filePath: filepath })
        expect(result.metadata.preview).toBe(raw)
        expect(result.metadata.truncated).toBe(false)
        expect(result.output).not.toContain("<markdown_cell>")
      }),
    )
  }

  it.instance("reports empty or unreadable cells without leaking other payloads", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "empty.ipynb")
      for (const cells of [[], [null, { cell_type: "raw", source: "hidden" }, { cell_type: "code", source: 7 }]]) {
        yield* put(filepath, JSON.stringify({ cells, metadata: "hidden" }))
        const result = yield* run({ filePath: filepath })
        expect(result.metadata.preview).toBe("(Notebook contains no markdown or code cell content.)")
        expect(result.metadata.display).toMatchObject({ totalLines: 1, truncated: false })
        expect(result.output).not.toContain("hidden")
      }
      yield* put(
        filepath,
        JSON.stringify({
          cells: [
            { cell_type: "code", source: [] },
            { cell_type: "markdown", source: "" },
          ],
        }),
      )
      const result = yield* run({ filePath: filepath })
      expect(result.metadata.preview).toBe("<code_cell>\n\n</code_cell>\n\n<markdown_cell>\n\n</markdown_cell>")
    }),
  )

  it.instance("pages extracted lines, clamps zero limit, and validates offsets", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "paged.ipynb")
      yield* put(filepath, JSON.stringify({ cells: [{ cell_type: "code", source: "first\nsecond\nthird" }] }))
      const result = yield* run({ filePath: filepath, offset: 2, limit: 2 })
      expect(result.metadata.preview).toBe("first\nsecond")
      expect(result.metadata.display).toEqual({
        type: "file",
        path: filepath,
        text: "first\nsecond",
        lineStart: 2,
        lineEnd: 3,
        totalLines: 5,
        truncated: true,
      })
      expect(result.output).toContain("2: first\n3: second")
      expect(result.output).toContain("Showing lines 2-3 of 5. Use offset=4 to continue.")
      const last = yield* run({ filePath: filepath, offset: 4, limit: 2 })
      expect(last.metadata.preview).toBe("third\n</code_cell>")
      expect(last.metadata.truncated).toBe(false)
      expect(last.output).toContain("End of file - total 5 lines")
      const zero = yield* run({ filePath: filepath, offset: 0, limit: 0 })
      expect(zero.metadata.preview).toBe("<code_cell>")
      expect(zero.output).toContain("Use offset=2 to continue.")
      const err = yield* fail(test.directory, { filePath: filepath, offset: 6 })
      expect(err.message).toContain("Offset 6 is out of range for this file (5 lines)")
    }),
  )

  it.instance("keeps the default line limit and preview cap on extracted text", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "many.ipynb")
      yield* put(filepath, JSON.stringify({ cells: [{ cell_type: "code", source: "x\n".repeat(2100) }] }))
      const result = yield* run({ filePath: filepath })
      expect(result.metadata.display).toMatchObject({ lineEnd: 2000, totalLines: 2102, truncated: true })
      expect(result.metadata.preview.split("\n")).toHaveLength(20)
      expect(result.output).toContain("Use offset=2001 to continue.")
    }),
  )

  it.instance("caps extracted UTF-8 bytes and long lines with resumable pagination", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "large.ipynb")
      yield* put(
        filepath,
        JSON.stringify({ cells: [{ cell_type: "code", source: `${"é".repeat(80)}\n`.repeat(800) }] }),
      )
      const result = yield* run({ filePath: filepath })
      const display = result.metadata.display
      if (display?.type !== "file") throw new Error("expected file display")
      expect(Buffer.byteLength(display.text)).toBeLessThanOrEqual(50 * 1024)
      expect(Buffer.byteLength(display.text) + 161).toBeGreaterThan(50 * 1024)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain(
        `Output capped at 50 KB. Showing lines 1-${display.lineEnd}. Use offset=${display.lineEnd + 1}`,
      )
      const next = yield* run({ filePath: filepath, offset: display.lineEnd + 1, limit: 1 })
      expect(next.metadata.preview).toBe("é".repeat(80))
      yield* put(filepath, JSON.stringify({ cells: [{ cell_type: "markdown", source: "x".repeat(3000) }] }))
      const long = yield* run({ filePath: filepath })
      expect(long.metadata.preview).toBe(
        `<markdown_cell>\n${"x".repeat(2000)}... (line truncated to 2000 chars)\n</markdown_cell>`,
      )
      yield* put(filepath, `not JSON\n${"x".repeat(80)}\n`.repeat(800))
      const fallback = yield* run({ filePath: filepath })
      expect(fallback.output).toContain("Output capped at 50 KB")
    }),
  )

  it.live("preserves external/read permissions and loaded instructions", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const outer = yield* tmpdirScoped()
      const filepath = path.join(outer, "nested", "analysis.ipynb")
      const instructions = path.join(outer, "nested", "AGENTS.md")
      yield* put(instructions, "# Notebook test instructions")
      yield* put(filepath, JSON.stringify({ cells: [{ cell_type: "code", source: "print(1)" }] }))
      const { items, next } = asks()
      const result = yield* exec(dir, { filePath: filepath }, next)
      expect(items.map((item) => item.permission)).toEqual(["external_directory", "read"])
      expect(items[1].patterns).toEqual([path.relative(dir, filepath)])
      expect(result.metadata.loaded).toEqual([])
      const local = yield* exec(outer, { filePath: filepath })
      expect(local.metadata.loaded).toContain(instructions)
      expect(local.output).toContain("<system-reminder>")
      expect(local.output).toContain("# Notebook test instructions")
      const fs = yield* FSUtil.Service
      let opened = false
      const err = yield* fail(
        dir,
        { filePath: filepath },
        {
          ...ctx,
          ask: () => Effect.die(new Error("permission denied")),
        },
      ).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            readFile: (file) => {
              opened = true
              return fs.readFile(file)
            },
          }),
        ),
      )
      expect(err.message).toContain("permission denied")
      expect(opened).toBe(false)
    }),
  )

  it.instance("interrupts pending notebook I/O without returning extracted content", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "cancel.ipynb")
      yield* put(filepath, JSON.stringify({ cells: [] }))
      const fs = yield* FSUtil.Service
      const started = yield* Deferred.make<void>()
      let finalized = false
      const fiber = yield* run({ filePath: filepath }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            readFile: (file) =>
              file !== filepath
                ? fs.readFile(file)
                : Effect.gen(function* () {
                    yield* Deferred.succeed(started, undefined)
                    return yield* Effect.never
                  }).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        finalized = true
                      }),
                    ),
                  ),
          }),
        ),
        Effect.forkChild,
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      if (!Exit.isFailure(exit)) throw new Error("expected interrupted read")
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(finalized).toBe(true)
    }),
  )

  it.instance("keeps JSON text and native image/PDF attachment behavior", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const raw = JSON.stringify({ cells: [{ cell_type: "code", source: "print(1)" }] })
      const json = path.join(test.directory, "notebook.json")
      yield* put(json, raw)
      expect((yield* run({ filePath: json })).metadata.preview).toBe(raw)
      for (const [name, bytes, mime, output] of [
        ["document.pdf", Buffer.from("%PDF-1.4\nminimal content"), "application/pdf", "PDF read successfully"],
        ["disguised.ipynb", Buffer.from("%PDF-1.4\nminimal content"), "application/pdf", "PDF read successfully"],
        [
          "image.ipynb",
          Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
          "image/jpeg",
          "Image read successfully",
        ],
      ] as const) {
        const filepath = path.join(test.directory, name)
        yield* put(filepath, bytes)
        const result = yield* run({ filePath: filepath })
        expect(result.output).toBe(output)
        expect(result.metadata.truncated).toBe(false)
        expect(result.attachments?.[0]).toEqual({
          type: "file",
          mime,
          url: `data:${mime};base64,${bytes.toString("base64")}`,
        })
      }
    }),
  )
})

describe("tool.read loaded instructions", () => {
  it.live("loads AGENTS.md from parent directory and includes in metadata", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "AGENTS.md"), "# Test Instructions\nDo something special.")
      yield* put(path.join(dir, "subdir", "nested", "test.txt"), "test content")

      const result = yield* exec(dir, { filePath: path.join(dir, "subdir", "nested", "test.txt") })
      expect(result.output).toContain("test content")
      expect(result.output).toContain("system-reminder")
      expect(result.output).toContain("Test Instructions")
      expect(result.metadata.loaded).toBeDefined()
      expect(result.metadata.loaded).toContain(path.join(dir, "subdir", "AGENTS.md"))
    }),
  )
})

describe("tool.read binary detection", () => {
  it.live("rejects text extension files with null bytes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bytes = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64])
      yield* put(path.join(dir, "null-byte.txt"), bytes)

      const err = yield* fail(dir, { filePath: path.join(dir, "null-byte.txt") })
      expect(err.message).toContain("Cannot read binary file")
    }),
  )

  it.live("rejects known binary extensions", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "module.wasm"), "not really wasm")

      const err = yield* fail(dir, { filePath: path.join(dir, "module.wasm") })
      expect(err.message).toContain("Cannot read binary file")
    }),
  )
})
