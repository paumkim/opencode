import { describe, expect, test, afterAll } from "bun:test"
import { Storage } from "../../src/core/storage"

// Storage only has remote adapters, so these cases exercise the S3 `list-type=2`
// request and its response parsing against a live bucket. There is no local
// adapter and no seam to inject one, so with nothing configured the suite could
// only ever report "No storage adapter configured", and with something
// configured it writes to and deletes from whatever bucket that is. Skipping
// states the precondition instead of hiding it behind a failure. The package has
// no `test` script, so this never runs in CI either way.
const configured = Boolean(process.env.OPENCODE_STORAGE_ADAPTER)

describe.skipIf(!configured)("core.storage", () => {
  test("should list files with after and before range", async () => {
    await Storage.write(["test", "users", "user1"], { name: "user1" })
    await Storage.write(["test", "users", "user2"], { name: "user2" })
    await Storage.write(["test", "users", "user3"], { name: "user3" })
    await Storage.write(["test", "users", "user4"], { name: "user4" })
    await Storage.write(["test", "users", "user5"], { name: "user5" })

    const result = await Storage.list({ prefix: ["test", "users"], after: "user2", before: "user4" })

    expect(result).toEqual([["test", "users", "user3"]])
  })

  test("should list files with after only", async () => {
    const result = await Storage.list({ prefix: ["test", "users"], after: "user3" })

    expect(result).toEqual([
      ["test", "users", "user4"],
      ["test", "users", "user5"],
    ])
  })

  test("should list files with limit", async () => {
    const result = await Storage.list({ prefix: ["test", "users"], limit: 3 })

    expect(result).toEqual([
      ["test", "users", "user1"],
      ["test", "users", "user2"],
      ["test", "users", "user3"],
    ])
  })

  test("should list all files without prefix", async () => {
    const result = await Storage.list()

    expect(result.length).toBeGreaterThan(0)
  })

  test("should list all files with prefix", async () => {
    const result = await Storage.list({ prefix: ["test", "users"] })

    expect(result).toEqual([
      ["test", "users", "user1"],
      ["test", "users", "user2"],
      ["test", "users", "user3"],
      ["test", "users", "user4"],
      ["test", "users", "user5"],
    ])
  })

  afterAll(async () => {
    const testFiles = await Storage.list({ prefix: ["test"] })

    for (const file of testFiles) {
      await Storage.remove(file)
    }

    const remainingFiles = await Storage.list({ prefix: ["test"] })
    expect(remainingFiles).toEqual([])
  })
})
