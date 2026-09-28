import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("../../src/prompt/stash.tsx", import.meta.url), "utf-8")

/**
 * Comments are stripped before asserting. An assertion like `not.toMatch(/catch\(\(\) => \{\}\)/)` run
 * against the raw file is satisfied by the prose explaining the fix - which is exactly what happened
 * the first time this test ran. The assertion has to be about code.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n")

/**
 * A stash is work the user deliberately set aside, and the list in the UI is the only record that it
 * existed. Three things used to be true at once:
 *
 *   1. `readText(stashPath).catch(() => "")` - a stash file that could not be *read* became an
 *      empty stash, and the entries were then overwritten by the self-heal write below it.
 *   2. `push` updated the in-memory store *before* writing, so a failed write left the UI listing a
 *      stash that was gone on the next launch.
 *   3. the writes were `writeText`, which truncates the target before writing - a failure part way
 *      through destroyed up to 50 previously-good entries.
 *
 * There is no solid mount for this context in this suite, so the wiring is checked against the
 * source. The assertions name the *old shapes* rather than describing intent, so a comment cannot
 * satisfy them.
 */
test("a failed read is not treated as an empty stash, and is reported", () => {
  expect(code).toContain("isMissingFile(error)")
  expect(code).toContain("Could not read your stashes")
  // The old shape: a read failure and a first run answered identically.
  expect(code).not.toContain('readText(stashPath).catch(() => "")')
})

test("every write reports a failure instead of dropping it", () => {
  // No `.catch(() => {})` anywhere in this file: it is the one construct that cannot fail, and
  // every path here is a path where the user believes something was saved.
  expect(code).not.toMatch(/\.catch\(\(\) => \{\}\)/)

  // The single helper both rewrites go through reports, and so does the plain append. Asserted on
  // the template rather than on a finished string, because the reason is a parameter - a test that
  // looked for "Could not save your stashes" in the source would not find it, which is a fault in
  // the test rather than in the code.
  expect(code).toContain("Could not save your ${reason}")
  expect(code).toContain("Could not save your stash")

  // And every write path reaches one of them. Counting callers rather than matching call sites
  // keeps this true if the implementation is reorganised.
  const writes = code.match(/\bpersist\(/g)?.length ?? 0
  expect(writes).toBeGreaterThanOrEqual(4)
  expect(code).toContain("appendText(stashPath")
})

test("writes go through the atomic primitive, not the truncating one", () => {
  expect(code).toContain("writeTextAtomic(stashPath")
  // `writeText` truncates the target before writing, so a partial failure destroys the entries
  // that were already there. This is the whole difference between a lost save and lost work.
  expect(code).not.toMatch(/\bwriteText\(stashPath/)
})

test("writeTextAtomic writes a temporary file and renames it over the target", () => {
  // The atomicity property, checked structurally, because it cannot be induced behaviourally: it
  // takes a failure part way through a write to observe, and filling the disk is not something a
  // test can do to the real one. What matters is that the destination is never opened for writing
  // directly - that is the only way a partial write can destroy entries the user already had.
  const impl = readFileSync(new URL("../../src/util/persistence.ts", import.meta.url), "utf-8")
  const implCode = impl
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n")
  const body = implCode.slice(implCode.indexOf("export async function writeTextAtomic"))

  expect(body).toContain("Bun.write(temporary, content)")
  expect(body).toContain("rename(temporary, filePath)")
  // The old body wrote the target in place, which truncates it first.
  expect(body).not.toMatch(/Bun\.write\(filePath/)
  // And it cleaned up on the failure path, so a failed write leaves nothing in the state directory.
  expect(body).toContain("rm(temporary, { force: true })")
})
