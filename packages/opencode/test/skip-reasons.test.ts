import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

// An unconditional `.skip()` is invisible: the test reports as passing, the suite stays green, and
// nothing fails while it checks nothing. That is not hypothetical here. `test/v2/
// session-message-updater.test.ts` had three tests skipped by 7f571d36e -- a commit whose subject was
// "move database schema ownership" and whose only change to that file was rewriting import paths. The
// skips were not revisited, so those three tests had asserted nothing since May 2026 while a later
// change (`metadata`/`resultMetadata` splitting, and the assistant message moving to be appended at
// `step.started`) went in completely uncovered.
//
// A skip is legitimate: a test for behaviour that is deliberately disabled, a test awaiting a native
// binding, a recorded-fixture scenario with no recording. What is not legitimate is an invisible one.
// So the rule this enforces is not "no skips" but "every unconditional skip says why" -- the reason
// lives in the file, where the next person decides whether the reason still holds.
//
// Conditional forms are deliberately out of scope and are not matched here:
//   - `test.skipIf(cond)` / `describe.skipIf(cond)` are self-documenting: the condition is the reason.
//   - The `.skip` members of the `it` helpers in `test/lib/effect.ts` and `test/lib/recorded-runner.ts`
//     are runner plumbing, not test cases. `lib/effect.ts` defines them for `.only`; `recorded-runner.ts`
//     returns them from inside a `test` wrapper to honour a filter.
const SKIP = /(^|[^\w.])(?:[\w$.]*\.)?(?:test|it|describe)\.skip\(/
const PLUMBING = new Set([path.join("test", "lib", "effect.ts"), path.join("test", "lib", "recorded-runner.ts")])

// A `//` or `/* */` in the few lines above the skip. Long enough to clear a preceding test's trailing
// assertion, short enough that the note has to be about this skip.
const LOOKBACK = 6

async function walk(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(directory, entry.name)
      return entry.isDirectory() ? walk(full) : Promise.resolve([full])
    }),
  )
  return nested.flat()
}

describe("skipped tests", () => {
  test("every unconditional skip states why it is skipped", async () => {
    const files = (await walk(import.meta.dirname)).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    expect(files.length).toBeGreaterThan(0)

    const unexplained: string[] = []
    for (const file of files) {
      const relative = path.relative(path.join(import.meta.dirname, ".."), file)
      if (PLUMBING.has(relative)) continue
      const lines = (await fs.readFile(file, "utf8")).split("\n")
      lines.forEach((line, index) => {
        if (!SKIP.test(line)) return
        const context = lines.slice(Math.max(0, index - LOOKBACK), index + 1).join("\n")
        if (context.includes("//") || context.includes("/*")) return
        unexplained.push(`${relative}:${index + 1}: ${line.trim()}`)
      })
    }

    expect(unexplained).toEqual([])
  })
})
