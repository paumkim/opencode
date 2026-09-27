import { expect, it } from "bun:test"
import { Ignore } from "@opencode-ai/core/filesystem/ignore"

// `PATTERNS` is the only export of this module that anything uses: `watcher.ts:144` spreads it
// into the `ignore` list handed to `@parcel/watcher`. Nothing pinned its shape, so an entry
// could be dropped, duplicated, or turned into something the watcher's matcher reads
// differently, with no test noticing.
it("exposes two distinguishable halves", () => {
  const patterns = Ignore.PATTERNS
  expect(patterns.length).toBeGreaterThan(0)

  // No pattern is blank or carries stray whitespace; either would match nothing at all.
  expect(patterns.every((pattern) => pattern.length > 0 && pattern.trim() === pattern)).toBe(true)

  // A duplicate in an ignore list is harmless at runtime, which is exactly why it goes
  // unnoticed. `FOLDERS` is a Set, so this can only catch a collision *between* the two
  // halves -- one entry string appearing in both literals.
  expect(new Set(patterns).size).toBe(patterns.length)

  // The file half is globbed and the folder half is a bare name, and the two halves must stay
  // recognizable. They are handed to one matcher, so a folder entry that quietly grows a glob
  // would change which of the two engines decides the answer.
  const files = patterns.filter((pattern) => pattern.startsWith("**/"))
  const folders = patterns.filter((pattern) => !pattern.startsWith("**/"))
  expect(files.length).toBeGreaterThan(0)
  expect(folders.length).toBeGreaterThan(0)
  expect(folders.every((name) => !/[*?[\]{}]/.test(name))).toBe(true)
})

// The vendored and build-output directories the list exists to skip. Asserting the ones a user
// would notice keeps a trimmed list from looking intentional.
it("still skips the vendored and build directories", () => {
  for (const name of ["node_modules", "dist", "build", "target", ".git", "vendor"]) {
    expect(Ignore.PATTERNS).toContain(name)
  }
  // `coverage` is deliberately in the file half, as a globbed directory, not a bare name.
  for (const pattern of ["**/.DS_Store", "**/*.pyc", "**/*.log", "**/coverage/**"]) {
    expect(Ignore.PATTERNS).toContain(pattern)
  }
  expect(Ignore.PATTERNS).not.toContain("coverage")
})
