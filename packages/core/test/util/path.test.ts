import { describe, expect, test } from "bun:test"
import {
  getDirectory,
  getFileExtension,
  getFilename,
  getFilenameTruncated,
} from "@opencode-ai/core/util/path"

describe("util.path.getFilename", () => {
  test("returns the basename across both separators", () => {
    expect(getFilename("/a/b/c.ts")).toBe("c.ts")
    expect(getFilename("C:\\x\\y.ts")).toBe("y.ts")
    expect(getFilename("c.ts")).toBe("c.ts")
  })

  test("ignores trailing separators", () => {
    expect(getFilename("/a/b/")).toBe("b")
    expect(getFilename("a/b///")).toBe("b")
  })

  test("is empty when there is no basename", () => {
    expect(getFilename(undefined)).toBe("")
    expect(getFilename("")).toBe("")
    expect(getFilename("/")).toBe("")
  })
})

describe("util.path.getDirectory", () => {
  test("returns the parent with a trailing separator", () => {
    expect(getDirectory("/a/b/c.ts")).toBe("/a/b/")
    expect(getDirectory("a/b/c.ts")).toBe("a/b/")
    expect(getDirectory("C:\\x\\y.ts")).toBe("C:/x/")
  })

  test("ignores trailing separators", () => {
    expect(getDirectory("/a/b/")).toBe("/a/")
    expect(getDirectory("a/b/")).toBe("a/")
  })

  test("does not invent a root directory for a bare relative name", () => {
    // A bare name has no directory component, so claiming "/" would render a
    // filesystem root in breadcrumb chrome for a file sitting in the cwd.
    expect(getDirectory("Makefile")).toBe("")
    expect(getDirectory("file.txt")).toBe("")
  })

  test("is empty when there is no path", () => {
    expect(getDirectory(undefined)).toBe("")
    expect(getDirectory("")).toBe("")
  })

  test("treats the root as its own directory", () => {
    expect(getDirectory("/")).toBe("/")
  })
})

describe("util.path.getFileExtension", () => {
  test("returns the extension without the dot", () => {
    expect(getFileExtension("/a/b/c.ts")).toBe("ts")
    expect(getFileExtension("archive.tar.gz")).toBe("gz")
    expect(getFileExtension("C:\\x\\y.ts")).toBe("ts")
  })

  test("does not read a dot from a parent directory as the extension", () => {
    expect(getFileExtension("/a.b/c")).toBe("")
    expect(getFileExtension("a/b/Makefile")).toBe("")
  })

  test("treats a leading dot as part of the name, not an extension", () => {
    expect(getFileExtension(".gitignore")).toBe("")
    expect(getFileExtension("/a/.gitignore")).toBe("")
  })

  test("is empty for a directory or a pathless input", () => {
    expect(getFileExtension("/a/b/")).toBe("")
    expect(getFileExtension(undefined)).toBe("")
    expect(getFileExtension("")).toBe("")
  })
})

describe("util.path.getFilenameTruncated", () => {
  const LONG = "a-very-long-file-name-here.tsx"

  test("leaves a short name alone", () => {
    expect(getFilenameTruncated("c.ts")).toBe("c.ts")
    expect(getFilenameTruncated(undefined)).toBe("")
  })

  test("keeps the extension and fits the budget", () => {
    expect(getFilenameTruncated(LONG, 20)).toBe("a-very-long-fil….tsx")
    expect(getFilenameTruncated(LONG, 20)).toHaveLength(20)
    expect(getFilenameTruncated(LONG, 14)).toBe("a-very-lo….tsx")
  })

  test("never returns more characters than the budget", () => {
    for (let maxLength = 0; maxLength <= 20; maxLength += 1) {
      expect(getFilenameTruncated(LONG, maxLength).length).toBeLessThanOrEqual(maxLength)
    }
  })
})
