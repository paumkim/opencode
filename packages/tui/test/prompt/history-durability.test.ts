import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("../../src/prompt/history.tsx", import.meta.url), "utf-8")

/**
 * Comments are stripped before asserting. Run against the raw file, a
 * `not.toMatch(/\.catch\(\(\) => \{\}\)/)` is satisfied by the prose explaining the fix - which is
 * exactly what happened to the equivalent assertion for the prompt stash. An assertion about code
 * has to run on code.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n")

/**
 * The prompt history is the user's own record of what they sent, and the up-arrow list is the only
 * way they get it back. Three ways it was lost, all silent, and the same three the prompt stash had
 * one unit ago:
 *
 *   1. `readText(historyPath).catch(() => "")` - a history file that could not be *read* became an
 *      empty history, and the self-heal write a line below then overwrote it.
 *   2. every write ended in `.catch(() => {})` while the in-memory store was updated first, so a
 *      failed write left the UI listing prompts that were never persisted.
 *   3. the writes were `writeText`, which truncates the target first, so a failure part way through
 *      destroyed up to 50 previously-good entries.
 *
 * There is no solid mount for this context in this suite, so the wiring is checked against the
 * source. Each assertion names the old shape rather than describing intent.
 */
test("a failed read is not treated as an empty history, and is reported", () => {
  expect(code).toContain("isMissingFile(error)")
  expect(code).toContain("Could not read your prompt history")
  expect(code).not.toContain('readText(historyPath).catch(() => "")')
})

test("every write reports a failure instead of dropping it", () => {
  expect(code).not.toMatch(/\.catch\(\(\) => \{\}\)/)
  // The helper's reason is a parameter, so the template is what appears in the source.
  expect(code).toContain("Could not save your ${reason}")
  expect(code).toContain("Could not add that to your history")
  // Both rewrite paths reach the reporting helper, named individually rather than counted - a
  // count is a guess about how many there should be, and the guess is the part that rots. The
  // first is the self-heal on mount, the second is the trim that rewrites the whole file.
  expect(code).toContain('await persist("history")')
  expect(code).toContain('return persist("history")')
  // And the plain append, which is the common case, reports on its own.
  expect(code).toContain("appendText(historyPath")
})

test("writes go through the atomic primitive, not the truncating one", () => {
  expect(code).toContain("writeTextAtomic(historyPath")
  expect(code).not.toMatch(/\bwriteText\(historyPath/)
})
