import { describe, expect, test } from "bun:test"
import { loadModule } from "../../function/test/isolated-module"

// Import only the stateless harness, never another package's test entrypoint.
// Solid request/session boundaries and Vite defines are fixture-local; this
// checks production cookie options, not encrypted cookies or browser behavior.
describe("production session cookie options", () => {
  const cases = [
    [false, "https://opencode.ai", true],
    [false, "http://opencode.ai", true],
    [false, "http://localhost:3000", true],
    [true, "https://localhost:3000", true],
    [true, "https://dev.opencode.ai", true],
    [true, "http://dev.opencode.ai", true],
    [true, "http://localhost:3000", false],
    [true, "http://127.0.0.1:3000", false],
    [true, "http://[::1]:3000", false],
    [true, "http://localhost.example.test", true],
    [true, undefined, true],
    [false, undefined, true],
  ] as const
  for (const [dev, url, secure] of cases)
    test(`dev=${dev} url=${url} secure=${secure}`, async () => {
      const unused = () => {
        throw new Error("Unexpected actor/database access in cookie test")
      }
      const module = await loadModule<{ useAuthSession: () => unknown }>(
        new URL("../src/context/auth.ts", import.meta.url),
        {
          createClient: () => ({}),
          getRequestEvent: () => (url ? { request: new Request(url) } : undefined),
          Resource: { ZEN_SESSION_SECRET: { value: "fixture-only-not-a-secret" } },
          useSession: (options: unknown) => options,
          and: unused,
          Database: {},
          eq: unused,
          inArray: unused,
          isNull: unused,
          sql: unused,
          UserTable: {},
          WorkspaceTable: {},
          redirect: unused,
          Actor: {},
        },
        dev,
      )
      expect(module.useAuthSession()).toEqual({
        password: "fixture-only-not-a-secret",
        name: "auth",
        maxAge: 60 * 60 * 24 * 365,
        cookie: { secure, httpOnly: true },
      })
    })
})
