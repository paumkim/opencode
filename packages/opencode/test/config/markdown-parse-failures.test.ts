import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { ConfigAgent } from "@/config/agent"
import { ConfigCommand } from "@/config/command"
import { ConfigMarkdown } from "@/config/markdown"
import { FrontmatterError } from "@opencode-ai/core/v1/config/error"

// An unterminated double quote is the shape of frontmatter `sanitize` cannot rescue (it leaves quoted
// values alone on purpose), so it reaches `parse` as a genuine YAML failure. It is also what
// `gray-matter` used to swallow via its content-keyed cache, which is why these loaders had nothing
// to report: they were never handed an error at all.
const BROKEN = '---\ndescription: "unterminated\n---\n\nYou are a helpful agent.\n'
const VALID = "---\ndescription: useful\n---\n\nBody here.\n"

// Writes the given `[subdirectory, filename, contents]` entries under `<base>/.opencode` and returns
// that directory, so a test can read the absolute path back out of the error it expects. The caller
// owns the temporary directory: `tmpdir` disposes on scope exit, so a helper that created its own
// would delete the files before the assertions ran.
async function writeConfig(base: string, entries: [string, string, string][]) {
  const config = path.join(base, ".opencode")
  for (const [subdirectory, filename, contents] of entries) {
    const dir = path.join(config, subdirectory)
    await Bun.$`mkdir -p ${dir}`.quiet()
    await Bun.write(path.join(dir, filename), contents)
  }
  return config
}

async function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
}

describe("config entry loaders report a frontmatter they cannot parse", () => {
  test("ConfigAgent.load rejects with a FrontmatterError naming the file", async () => {
    await using tmp = await tmpdir()
    const config = await writeConfig(tmp.path, [["agents", "broken.md", BROKEN]])
    const result = await settled(ConfigAgent.load(config))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(FrontmatterError.isInstance(result.error)).toBe(true)
    if (!FrontmatterError.isInstance(result.error)) return
    expect(result.error.data.path).toBe(path.join(config, "agents", "broken.md"))
    // The YAML problem itself, not just "failed to parse".
    expect(result.error.data.message).toContain("double quoted scalar")
  })

  test("ConfigCommand.load rejects with a FrontmatterError naming the file", async () => {
    await using tmp = await tmpdir()
    const config = await writeConfig(tmp.path, [["command", "broken.md", BROKEN]])
    const result = await settled(ConfigCommand.load(config))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(FrontmatterError.isInstance(result.error)).toBe(true)
    if (!FrontmatterError.isInstance(result.error)) return
    expect(result.error.data.path).toBe(path.join(config, "command", "broken.md"))
  })

  // Why the swallowed error mattered: the whole file -- `---` fences and broken YAML included -- used
  // to reach the model as the agent's prompt, so unparsed configuration crossed into the instruction
  // channel. A valid file must still behave exactly as before.
  test("a valid agent still loads, with only its body as the prompt", async () => {
    await using tmp = await tmpdir()
    const config = await writeConfig(tmp.path, [["agents", "good.md", VALID]])
    const loaded = await ConfigAgent.load(config)

    expect(Object.keys(loaded)).toEqual(["good"])
    expect(loaded.good?.prompt).toBe("Body here.")
    expect(loaded.good?.description).toBe("useful")
  })
})

describe("ConfigMarkdown.parseEntry", () => {
  // A file we cannot read is not a config mistake, and a path that vanished between the glob and the
  // read must not fail the whole load -- that was the other half of what the old
  // `.catch(() => undefined)` was silently covering up.
  test("skips a file it cannot read", async () => {
    expect(await ConfigMarkdown.parseEntry(path.join("/nonexistent-opencode-test", "gone.md"))).toBeUndefined()
  })

  test("reports a file whose frontmatter does not parse", async () => {
    await using tmp = await tmpdir()
    const config = await writeConfig(tmp.path, [["agents", "broken.md", BROKEN]])
    const result = await settled(ConfigMarkdown.parseEntry(path.join(config, "agents", "broken.md")))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(FrontmatterError.isInstance(result.error)).toBe(true)
  })

  test("parses a valid file", async () => {
    await using tmp = await tmpdir()
    const config = await writeConfig(tmp.path, [["agents", "good.md", VALID]])
    const md = await ConfigMarkdown.parseEntry(path.join(config, "agents", "good.md"))

    expect(md?.data).toEqual({ description: "useful" })
    expect(md?.content).toBe("\nBody here.\n")
  })
})
