import { describe, expect, test } from "bun:test"
import { resolveBaseURL } from "@/provider/provider"

// A provider's base URL is templated with `${name}` and filled from a plugin's
// `vars` loader or the process environment. Loader values are credentials and
// account identifiers, and the fill used a *string* replacement, so the value
// was read as a `$-pattern` and, worse, rescanned by a later pass.
//
// Measured on the old implementation, with a URL of `https://h/${a}/v1`:
//
//   a = "x$&y"  ->  https://h/x${a}y/v1     (the placeholder echoed back as data)
//   a = "x$$y"  ->  https://h/x$y/v1        (silently shortened)
//   a = "x$'y"  ->  https://h/x/v1y/v1      (the trailing URL spliced in mid-value)
//   a = "x$`y"  ->  https://h/xhttps://h/v1y/v1
//
// Note `$1` and a bare `$name` are *not* affected: a string pattern has no
// capture groups, and `$` not followed by a recognised token is left alone. Only
// the four forms above are real, so only those are asserted as fixes.
describe("resolveBaseURL", () => {
  const envs = (record: Record<string, string>) => record

  test("substitutes from vars", () => {
    expect(resolveBaseURL("https://api.example.com/${org}/v1", { org: "acme" }, envs({}))).toBe(
      "https://api.example.com/acme/v1",
    )
  })

  test("substitutes from the environment when vars has no such key", () => {
    expect(resolveBaseURL("https://${host}/v1", undefined, envs({ host: "h.example.com" }))).toBe(
      "https://h.example.com/v1",
    )
  })

  // The old order applied every var first and only then the environment, so a
  // name present in both resolved to the var. Precedence must not change.
  test("prefers vars over the environment for the same name", () => {
    expect(resolveBaseURL("https://${x}/v1", { x: "from-vars" }, envs({ x: "from-env" }))).toBe("https://from-vars/v1")
  })

  test("leaves an unresolved placeholder in place", () => {
    expect(resolveBaseURL("https://${nope}/v1", { org: "acme" }, envs({}))).toBe("https://${nope}/v1")
  })

  test("substitutes every occurrence", () => {
    expect(resolveBaseURL("https://${a}/${a}", { a: "x" }, envs({}))).toBe("https://x/x")
  })

  test("inserts $& in a value literally", () => {
    expect(resolveBaseURL("https://h/${a}/v1", { a: "x$&y" }, envs({}))).toBe("https://h/x$&y/v1")
  })

  test("inserts $$ in a value literally", () => {
    expect(resolveBaseURL("https://h/${a}/v1", { a: "x$$y" }, envs({}))).toBe("https://h/x$$y/v1")
  })

  test("inserts $' in a value literally", () => {
    expect(resolveBaseURL("https://h/${a}/v1", { a: "x$'y" }, envs({}))).toBe("https://h/x$'y/v1")
  })

  test("inserts $` in a value literally", () => {
    expect(resolveBaseURL("https://h/${a}/v1", { a: "x$`y" }, envs({}))).toBe("https://h/x$`y/v1")
  })

  // Vars were substituted one at a time, so a value that itself looked like a
  // placeholder was rewritten by a later var. This is the one that could redirect
  // a request: `a = "X${b}Y"` became `XINJECTEDY` because `b` was applied
  // afterwards. A single pass never revisits what it has already written.
  test("does not let a later var rewrite an earlier value", () => {
    expect(resolveBaseURL("https://h/${a}/${b}", { a: "X${b}Y", b: "INJECTED" }, envs({}))).toBe(
      "https://h/X${b}Y/INJECTED",
    )
  })

  // The same hazard one pass later: the environment pass re-examined text the
  // vars pass had just written.
  test("does not let the environment rewrite a value the vars pass wrote", () => {
    expect(resolveBaseURL("https://h/${a}", { a: "X${SECRET}Y" }, envs({ SECRET: "INJECTED" }))).toBe(
      "https://h/X${SECRET}Y",
    )
  })

  test("returns a URL with no placeholders unchanged", () => {
    expect(resolveBaseURL("https://h/v1", { a: "x" }, envs({ b: "y" }))).toBe("https://h/v1")
  })
})
