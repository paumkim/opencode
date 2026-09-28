import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("../../src/prompt/frecency.tsx", import.meta.url), "utf-8")

/** Comments are stripped before asserting: a `not.toMatch(/\.catch\(\(\) => \{\}\)/)` run against
 * the raw file is satisfied by the prose explaining the fix. An assertion about code runs on code. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n")

/**
 * The third and last of the prompt stores with this shape, after the stash and the history.
 *
 * Frecency is lower stakes than those two - it orders the file suggestions rather than holding the
 * user's work - but the read is the same lie in both directions. A frecency file that could not be
 * *read* loads as an empty store, so every file the user has ever opened looks like a file they
 * have never opened, and the suggestions they rely on quietly stop. The self-heal rewrite below
 * then overwrites the file it failed to read.
 *
 * The write is the sharper half. `MAX_FRECENCY_ENTRIES` is 1000, the largest of the three stores, so
 * a `writeText` that fails part way through - and `writeText` is `Bun.write`, which truncates the
 * target first - replaces up to a thousand entries with a partial file.
 */
test("a failed read is not treated as an empty frecency store, and is reported", () => {
  expect(code).toContain("isMissingFile(error)")
  expect(code).toContain("Could not read your file history")
  expect(code).not.toContain('readText(frecencyPath).catch(() => "")')
})

test("every write reports a failure instead of dropping it", () => {
  expect(code).not.toMatch(/\.catch\(\(\) => \{\}\)/)
  // The helper's reason is a parameter, so the template is what appears in the source.
  expect(code).toContain("Could not save your ${reason}")
  expect(code).toContain("Could not record that file")
  // Both rewrite paths reach the helper, distinguished by how they are awaited rather than by the
  // local variable they pass - the self-heal on mount is awaited, the trim that fires during an
  // open cannot be. Asserting on the variable names instead would pin the implementation rather
  // than the behaviour, and would have failed here for the right code.
  expect(code).toContain("await persist(")
  expect(code).toContain("void persist(")
  // And the per-open append, which is the common case, reports on its own.
  expect(code).toContain("appendText(frecencyPath")
})

test("writes go through the atomic primitive, not the truncating one", () => {
  expect(code).toContain("writeTextAtomic(frecencyPath")
  expect(code).not.toMatch(/\bwriteText\(frecencyPath/)
})
