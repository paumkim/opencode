import { describe, expect, test } from "bun:test"
import matter from "gray-matter"
import { ConfigMarkdown } from "@opencode-ai/core/config/markdown"

// `matter` is imported directly in one test below on purpose: it is the only way to reproduce the
// cache state that used to decide this module's behavior, and it is not used by the code under test.

describe("ConfigMarkdown.parse", () => {
  // The unquoted-colon retry is the whole reason `sanitize` exists -- other coding agents accept it,
  // so an existing config file must keep working. Guard it: a fix that made every parse fail would
  // satisfy the tests below just as well.
  test("still repairs the unquoted-colon frontmatter the fallback exists for", () => {
    const parsed = ConfigMarkdown.parse(`---\ndescription: Task: do it\nmodel: test/model\n---\nbody\n`)
    expect(parsed.data).toEqual({ description: "Task: do it", model: "test/model" })
    expect(parsed.content).toBe("body\n")
  })

  // A frontmatter that `sanitize` cannot repair used to come back as `{ data: {}, content: <the
  // whole file> }`, because the retry re-read the cache entry the failed first call had left behind.
  // Callers pass `content` to the model as the prompt, so the malformed frontmatter -- `---` fences
  // and all -- became instructions while the settings were dropped, with no error anywhere.
  test("rejects a frontmatter it cannot repair rather than returning it as content", () => {
    const content = '---\ndescription: "unterminated\n---\nbody\n'
    expect(() => ConfigMarkdown.parse(content)).toThrow(/double quoted scalar/)
  })

  test("rejects bad indentation, which sanitize also leaves alone", () => {
    const content = "---\na: 1\n a: 2\n---\nbody\n"
    expect(() => ConfigMarkdown.parse(content)).toThrow(/indentation/)
  })

  // Same input twice used to be a coin flip: the first call poisoned the cache, the second replayed
  // it as a success. `parse` must depend on its input alone.
  test("is repeatable: parsing the same broken content twice throws both times", () => {
    const content = "---\nfoo: [1, 2\n---\nbody\n"
    expect(() => ConfigMarkdown.parse(content)).toThrow()
    expect(() => ConfigMarkdown.parse(content)).toThrow()
  })

  // The strongest form of the above: something else in the process has already parsed this exact
  // string and failed, so gray-matter's content-keyed cache holds the unparsed file under it. A
  // `parse` that consulted that cache would return `data: {}` here and pass as a success.
  test("is unaffected by a cache entry another caller left behind for the same content", () => {
    const content = '---\ndescription: "unterminated\n---\nbody\n'
    try {
      matter(content)
      throw new Error("expected matter() to throw on this content")
    } catch (error) {
      if (error instanceof Error && error.message === "expected matter() to throw on this content") throw error
    }
    expect(() => ConfigMarkdown.parse(content)).toThrow(/double quoted scalar/)
  })

  // A file with no frontmatter is not an error; `parse` must keep treating it as all content.
  test("treats a file with no frontmatter as content", () => {
    const parsed = ConfigMarkdown.parse("# Title\n\nbody\n")
    expect(parsed.data).toEqual({})
    expect(parsed.content).toBe("# Title\n\nbody\n")
  })
})

describe("ConfigMarkdown.parseOption", () => {
  // Its contract is "parse or nothing", and unlike `parse` it is allowed to swallow: this is the
  // lenient entry point for callers that treat an unreadable entry as absent.
  test("returns undefined for a frontmatter it cannot repair", () => {
    expect(ConfigMarkdown.parseOption('---\ndescription: "unterminated\n---\nbody\n')).toBeUndefined()
  })

  test("returns the parsed file for valid frontmatter", () => {
    const parsed = ConfigMarkdown.parseOption("---\nname: build\n---\nbody\n")
    expect(parsed?.data).toEqual({ name: "build" })
  })
})
