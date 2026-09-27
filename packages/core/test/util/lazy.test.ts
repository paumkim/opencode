import { describe, expect, test } from "bun:test"
import { lazy } from "@opencode-ai/core/util/lazy"

describe("util.lazy", () => {
  test("runs the initializer once and caches its value", () => {
    let calls = 0
    const value = lazy(() => {
      calls += 1
      return { id: calls }
    })

    const first = value()
    const second = value()

    expect(calls).toBe(1)
    expect(second).toBe(first)
    expect(first.id).toBe(1)
  })

  test("caches a falsy value instead of recomputing it", () => {
    let calls = 0
    const value = lazy(() => {
      calls += 1
      return 0
    })

    expect(value()).toBe(0)
    expect(value()).toBe(0)
    expect(calls).toBe(1)
  })

  test("caches an undefined result without recomputing it", () => {
    let calls = 0
    const value = lazy(() => {
      calls += 1
      return undefined
    })

    expect(value()).toBeUndefined()
    expect(value()).toBeUndefined()
    expect(calls).toBe(1)
  })

  test("propagates the initializer error on every call", () => {
    // Marking the value as loaded before the initializer returns would cache the
    // failure as a successful `undefined`, so the first caller sees the real
    // error and every later caller sees a TypeError far from the cause.
    let calls = 0
    const value = lazy(() => {
      calls += 1
      throw new Error("No storage adapter configured")
    })

    expect(() => value()).toThrow("No storage adapter configured")
    expect(() => value()).toThrow("No storage adapter configured")
    expect(() => value()).toThrow("No storage adapter configured")
    expect(calls).toBe(3)
  })

  test("recovers once a later initializer succeeds", () => {
    // Synchronous initializers are the case that matters here: a configuration
    // read that is missing on the first call and present on the next must not
    // leave the lazy permanently dead.
    let attempt = 0
    const value = lazy(() => {
      attempt += 1
      if (attempt === 1) throw new Error("No storage adapter configured")
      return { ok: true }
    })

    expect(() => value()).toThrow("No storage adapter configured")
    expect(value()).toEqual({ ok: true })
    expect(value()).toEqual({ ok: true })
    expect(attempt).toBe(2)
  })
})
