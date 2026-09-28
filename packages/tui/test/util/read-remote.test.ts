import { describe, expect, test } from "bun:test"
import { readRemote } from "../../src/util/read-remote"

describe("readRemote", () => {
  test("returns the value on a successful read", async () => {
    const result = await readRemote(async () => ({ data: ["a"], error: undefined }), [])
    expect(result).toEqual({ ok: true, data: ["a"] })
  })

  // A successful read with no entries is a real, positive answer. It must not
  // be confused with the case below.
  test("an empty result is a success, not a failure", async () => {
    const result = await readRemote(async () => ({ data: [], error: undefined }), [])
    expect(result).toEqual({ ok: true, data: [] })
  })

  test("a read with no data at all falls back to the empty value", async () => {
    const result = await readRemote(async () => ({ data: undefined, error: undefined }), {})
    expect(result).toEqual({ ok: true, data: {} })
  })

  // The generated client does not reject on a non-2xx; it resolves with
  // `{ data: undefined, error }`. Collapsing that to the empty value is how
  // "the server is unreachable" became "you have no MCP servers".
  test("a typed API error is a failure with the server's own message", async () => {
    const result = await readRemote(
      async () => ({ data: undefined, error: { name: "McpFailed", data: { message: "spawn ENOENT" } } }),
      [],
    )
    expect(result).toEqual({ ok: false, reason: "spawn ENOENT" })
  })

  test("a transport failure is a failure too", async () => {
    const result = await readRemote(async () => {
      throw new Error("connection refused")
    }, [])
    expect(result).toEqual({ ok: false, reason: "connection refused" })
  })

  test("a falsy-but-present error is still a failure", async () => {
    // Guards the truthiness check: only an absent error means success.
    const result = await readRemote(async () => ({ data: undefined, error: 0 }), [])
    expect(result.ok).toBe(false)
  })
})
