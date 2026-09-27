import { test, expect } from "bun:test"
import { BashArity } from "../../src/permission/arity"

test("arity 1 - unknown commands default to first token", () => {
  expect(BashArity.prefix(["unknown", "command", "subcommand"])).toEqual(["unknown"])
  expect(BashArity.prefix(["touch", "foo.txt"])).toEqual(["touch"])
})

test("arity 2 - two token commands", () => {
  expect(BashArity.prefix(["git", "checkout", "main"])).toEqual(["git", "checkout"])
  expect(BashArity.prefix(["docker", "run", "nginx"])).toEqual(["docker", "run"])
})

test("arity 3 - three token commands", () => {
  expect(BashArity.prefix(["aws", "s3", "ls", "my-bucket"])).toEqual(["aws", "s3", "ls"])
  expect(BashArity.prefix(["npm", "run", "dev", "script"])).toEqual(["npm", "run", "dev"])
})

test("longest match wins - nested prefixes", () => {
  expect(BashArity.prefix(["docker", "compose", "up", "service"])).toEqual(["docker", "compose", "up"])
  expect(BashArity.prefix(["consul", "kv", "get", "config"])).toEqual(["consul", "kv", "get"])
})

test("exact length matches", () => {
  expect(BashArity.prefix(["git", "checkout"])).toEqual(["git", "checkout"])
  expect(BashArity.prefix(["npm", "run", "dev"])).toEqual(["npm", "run", "dev"])
})

test("edge cases", () => {
  expect(BashArity.prefix([])).toEqual([])
  expect(BashArity.prefix(["single"])).toEqual(["single"])
  expect(BashArity.prefix(["git"])).toEqual(["git"])
})

test("Object.prototype keys are not read as arities", () => {
  // ARITY is an object literal, so an inherited key used to look up a "function"
  // arity. `slice(0, function)` coerces to `slice(0, NaN)` and yields [], which
  // made the shell tool offer "always approve" as the bare pattern " *" — a
  // wildcard that permanently allows every command.
  for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
    expect(BashArity.prefix([key, "--rm", "-rf"])).toEqual([key])
    expect(BashArity.prefix([key, "sub", "command"])).toEqual([key])
  }
})

test("a real prefix still wins over an inherited key further left", () => {
  expect(BashArity.prefix(["git", "toString", "extra"])).toEqual(["git", "toString"])
})
