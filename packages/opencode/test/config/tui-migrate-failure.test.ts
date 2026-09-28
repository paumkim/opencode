import { describe, expect, test } from "bun:test"
import path from "path"
import { migrateFiles, type MigrateFs } from "@/config/tui-migrate"

const DIR = "/cfg"
const LEGACY = path.join(DIR, "opencode.json")
const TARGET = path.join(DIR, "tui.json")
const BACKUP = LEGACY + ".tui-migration.bak"

const WITH_THEME = JSON.stringify({ model: "anthropic/claude", theme: "tokyonight" }, null, 2)

/** A filesystem where everything succeeds, so each test can fail exactly one step. */
function working(overrides: Partial<MigrateFs> = {}) {
  const written = new Map<string, string>()
  const fs: MigrateFs = {
    readText: async () => WITH_THEME,
    exists: async () => false,
    write: async (file, content) => {
      written.set(file, content)
    },
    ...overrides,
  }
  return { fs, written }
}

describe("migrateFiles", () => {
  test("a read failure is reported instead of skipping the file in silence", async () => {
    // The migration is a one-way rewrite of the user's own config. A read that fails means the theme
    // in that file never reaches tui.json, and the run says nothing.
    const reported: string[] = []
    const { fs } = working({
      readText: async () => {
        throw new Error("EACCES: permission denied")
      },
    })
    await migrateFiles([LEGACY], fs, (m) => reported.push(m))
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain(LEGACY)
    expect(reported[0]).toContain("could not read")
    expect(reported[0]).toContain("EACCES")
  })

  test("a tui.json write failure is reported with the target path", async () => {
    // Without this the legacy keys stay in opencode.json and tui.json is never created, so the next
    // run retries - but the user has no idea their settings are not migrating.
    const reported: string[] = []
    const { fs } = working({
      write: async (file) => {
        if (file === TARGET) throw new Error("ENOSPC: no space left on device")
        return
      },
    })
    await migrateFiles([LEGACY], fs, (m) => reported.push(m))
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain(TARGET)
    expect(reported[0]).toContain("ENOSPC")
  })

  test("a failed strip is reported as permanent, because tui.json now blocks every retry", async () => {
    // The one failure that cannot be recovered from by running again. Once tui.json exists,
    // `targetExists` skips this directory forever, so the legacy keys stay in opencode.json
    // permanently. The old code returned false and moved on with no record of it.
    const reported: string[] = []
    const { fs, written } = working({
      write: async (file, content) => {
        if (file === LEGACY) throw new Error("EROFS: read-only file system")
        written.set(file, content)
      },
    })
    await migrateFiles([LEGACY], fs, (m) => reported.push(m))

    // The state it leaves behind, which is the part that matters: the migration half-happened.
    expect(written.has(TARGET)).toBe(true)
    expect(written.has(LEGACY)).toBe(false)
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain("could not remove the migrated keys")
    expect(reported[0]).toContain("duplicated in both files")
    // The load-bearing word. This is what tells the user a manual fix is needed rather than that a
    // later run will sort it out.
    expect(reported[0]).toContain("will not be retried")
    expect(reported[0]).toContain("EROFS")
  })

  test("a failed backup is reported as permanent and the source is left untouched", async () => {
    // Refusing to strip without a backup is correct - the backup is what makes the rewrite
    // reversible - but it is also unretryable, so it must not be silent.
    const reported: string[] = []
    const { fs, written } = working({
      write: async (file, content) => {
        if (file === BACKUP) throw new Error("ENOSPC: no space left on device")
        written.set(file, content)
      },
    })
    await migrateFiles([LEGACY], fs, (m) => reported.push(m))

    expect(written.has(LEGACY)).toBe(false)
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain(BACKUP)
    expect(reported[0]).toContain("left in place")
    expect(reported[0]).toContain("will not retry")
  })

  test("a malformed opencode.json is reported rather than skipped in silence", async () => {
    // The parse failure path also continued silently. The keys still load from that file, so the
    // TUI works - but the migration will never happen for it, and nothing says so.
    const reported: string[] = []
    const { fs, written } = working({ readText: async () => "{ this is not json" })
    await migrateFiles([LEGACY], fs, (m) => reported.push(m))
    expect(written.size).toBe(0)
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain("not valid JSON")
    expect(reported[0]).toContain(LEGACY)
  })

  test("a clean migration reports nothing", async () => {
    // The direction that must not regress: a normal migration is silent and does the work.
    const reported: string[] = []
    const { fs, written } = working()
    await migrateFiles([LEGACY], fs, (m) => reported.push(m))
    expect(reported).toEqual([])
    expect(written.has(TARGET)).toBe(true)
    expect(written.get(TARGET)).toContain("tokyonight")
    // The legacy keys are gone from the source, and a backup exists.
    expect(written.get(LEGACY)).not.toContain("theme")
    expect(written.has(BACKUP)).toBe(true)
  })

  test("a file with no tui keys to migrate reports nothing", async () => {
    const reported: string[] = []
    const { fs, written } = working({ readText: async () => JSON.stringify({ model: "anthropic/claude" }) })
    await migrateFiles([LEGACY], fs, (m) => reported.push(m))
    expect(reported).toEqual([])
    expect(written.size).toBe(0)
  })
})
