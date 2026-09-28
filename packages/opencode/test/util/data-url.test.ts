import { describe, expect, test } from "bun:test"
import { decodeDataUrl } from "../../src/util/data-url"

describe("decodeDataUrl", () => {
  test("decodes base64 data URLs", () => {
    const body = '{\n  "ok": true\n}\n'
    const url = `data:text/plain;base64,${Buffer.from(body).toString("base64")}`
    expect(decodeDataUrl(url)).toBe(body)
  })

  test("decodes plain data URLs", () => {
    expect(decodeDataUrl("data:text/plain,hello%20world")).toBe("hello world")
  })

  test("keeps a stray percent sign instead of throwing", () => {
    // decodeURIComponent throws URIError on a bare `%`. A caller running inside
    // an Effect.fn turns that throw into a defect that kills the whole prompt.
    expect(decodeDataUrl("data:text/plain,100% done")).toBe("100% done")
    expect(decodeDataUrl("data:text/plain,50%")).toBe("50%")
    expect(decodeDataUrl("data:text/plain,%zz")).toBe("%zz")
  })

  test("falls back to the raw body only when the escape is broken", () => {
    // A valid escape still decodes, even when a later stray `%` would have
    // poisoned the whole body under a naive catch-all.
    expect(decodeDataUrl("data:text/plain,hello%20world%20again")).toBe("hello world again")
  })

  test("returns empty for a data URL with no comma", () => {
    expect(decodeDataUrl("data:text/plain")).toBe("")
  })
})
