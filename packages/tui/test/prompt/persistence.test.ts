import { expect, test } from "bun:test"
import path from "path"
import { mkdir, mkdtemp, readdir, rm } from "fs/promises"
import { tmpdir } from "os"
import { appendText, readJson, readText, writeJsonAtomic, writeText, writeTextAtomic } from "../../src/util/persistence"

test("persistence creates parent directories and supports text, append, and JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-tui-persistence-"))
  try {
    const textPath = path.join(root, "nested", "state.jsonl")
    await writeText(textPath, "one\n")
    await appendText(textPath, "two\n")
    expect(await readText(textPath)).toBe("one\ntwo\n")

    const jsonPath = path.join(root, "other", "state.json")
    await writeJsonAtomic(jsonPath, { value: 1 })
    expect(await readJson<{ value: number }>(jsonPath)).toEqual({ value: 1 })
    await writeJsonAtomic(jsonPath, { value: 2 })
    expect(await readJson<{ value: number }>(jsonPath)).toEqual({ value: 2 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * NOT a proof of atomicity. It pins the three properties that can be observed directly: the call
 * rejects when the write cannot complete, the destination is never replaced by something other than
 * the file, and no `.tmp` survives either outcome.
 *
 * The atomicity itself - the destination is never truncated before the new content exists - needs
 * a failure *part way through* a write to observe, and the only way to produce one is to fill the
 * filesystem, which a test cannot do to the real disk. An earlier version of this test read as if
 * it covered that and passed just as happily against a plain non-atomic `Bun.write`, which is the
 * failure mode worth being careful about: a test that cannot tell the two implementations apart
 * certifies a property it does not check. The structural half lives in stash-durability.test.ts.
 */
test("writeTextAtomic replaces the file, propagates a failure, and leaves no temp file behind", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-tui-atomic-"))
  try {
    const file = path.join(root, "state.jsonl")
    await writeTextAtomic(file, "first\n")
    expect(await readText(file)).toBe("first\n")
    await writeTextAtomic(file, "second\n")
    expect(await readText(file)).toBe("second\n")

    // A directory where the file should be: the temp write succeeds but the rename cannot replace
    // it, which is the failure mode that matters - it happens *after* the new content exists. The
    // call has to reject rather than report success, and it has to clean up after itself, because
    // a leftover `.tmp` in the state directory is litter every later read has to ignore.
    const blocked = path.join(root, "blocked")
    await mkdir(blocked)
    await writeText(path.join(blocked, "child"), "x")

    let rejected = false
    try {
      await writeTextAtomic(blocked, "nope\n")
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
    // Still a directory, not silently replaced by a file.
    expect((await readdir(root)).includes("blocked")).toBe(true)

    // No temp files survive either the successful writes or the failure.
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
