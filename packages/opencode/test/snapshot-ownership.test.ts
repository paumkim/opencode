import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

// A snapshot is only ever read by the test file it is named after: bun resolves
// `foo.test.ts` to `__snapshots__/foo.test.ts.snap`. So a snapshot with no
// matching test file is unreachable, and nothing will ever fail when it rots.
// This repo already has one: `test/tool/tool.test.ts` was deleted in d0043a4a7
// and left `test/tool/__snapshots__/tool.test.ts.snap` behind, last meaningful
// edit in 4c34b69ae.
const testRoot = path.join(import.meta.dirname, "..")

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

describe("snapshot ownership", () => {
  test("every snapshot file has a test file that can read it", async () => {
    const files = await walk(testRoot)
    const snapshots = files.filter(
      (file) => file.includes(`${path.sep}__snapshots__${path.sep}`) && file.endsWith(".snap"),
    )
    expect(snapshots.length).toBeGreaterThan(0)

    const orphans: string[] = []
    for (const snapshot of snapshots) {
      // `__snapshots__/foo.test.ts.snap` is read only by `foo.test.ts`: bun names the snapshot file
      // after the test file, so dropping `__snapshots__/` and the trailing `.snap` is the whole rule.
      const owner = snapshot.replace(`${path.sep}__snapshots__${path.sep}`, path.sep).slice(0, -".snap".length)
      const exists = await fs
        .stat(owner)
        .then(() => true)
        .catch(() => false)
      if (!exists) orphans.push(path.relative(testRoot, snapshot))
    }

    expect(orphans).toEqual([])
  })
})
