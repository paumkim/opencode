import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { loadModule } from "./isolated-module"

// Exercise production callback validation and orchestration, not a copied
// algorithm. Provider I/O, issuer, logging, and database boundaries are local.
async function fixture(
  options: {
    provider?: string
    emails?: unknown
    user?: unknown
    status?: number
    brokenJSON?: boolean
    transport?: boolean
    verified?: boolean
    existing?: boolean
    stage?: string
    concurrent?: boolean
  } = {},
) {
  const logs: unknown[][] = []
  const calls: string[] = []
  const selected: unknown[] = []
  let writes = 0
  let created = 0
  let joined = 0
  let workspaceCreated = 0
  let issued: unknown[] | undefined
  const gate = Promise.withResolvers<void>()
  const provider = options.provider ?? "github"
  const response =
    provider === "github"
      ? { provider, tokenset: { access: "synthetic-access-marker", refresh: "synthetic-refresh-marker" } }
      : {
          provider,
          id: {
            sub: "synthetic-sub-marker",
            email: "test@anoma.ly",
            email_verified: options.verified ?? true,
            private_claim: "synthetic-private-marker",
          },
        }
  const db = {
    select() {
      const matches =
        options.existing === false
          ? []
          : [
              { provider, accountID: "account-test" },
              { provider: "email", accountID: "account-test" },
            ]
      const value = selected.length === 0 ? matches : []
      selected.push(value)
      const chain = { from: () => chain, innerJoin: () => chain, where: async () => value }
      return chain
    },
    insert() {
      writes++
      return { values: () => ({ onDuplicateKeyUpdate: async () => {} }) }
    },
  }
  const module = await loadModule<{
    default: { fetch: (request: Request, env: { AuthStorage: object }, ctx: object) => Promise<Response> }
  }>(new URL("../src/auth.ts", import.meta.url), {
    z,
    createSubjects: (value: unknown) => value,
    THEME_OPENAUTH: {},
    GithubProvider: () => ({}),
    GoogleOidcProvider: () => ({}),
    CloudflareStorage: () => ({}),
    Resource: {
      GITHUB_CLIENT_ID_CONSOLE: { value: "fixture" },
      GITHUB_CLIENT_SECRET_CONSOLE: { value: "fixture" },
      GOOGLE_CLIENT_ID: { value: "fixture" },
      App: { stage: options.stage ?? "production" },
    },
    issuer: (config: {
      success: (ctx: { subject: (...args: unknown[]) => Response }, response: unknown) => Promise<Response>
    }) => ({
      fetch: () =>
        config.success(
          {
            subject: (...args) => {
              issued = args
              return new Response("ok")
            },
          },
          response,
        ),
    }),
    isAllowedAuthorizationRedirect: () => false,
    console: { log: (...args: unknown[]) => logs.push(args) },
    fetch: async (url: string, init: RequestInit) => {
      calls.push(url)
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer synthetic-access-marker")
      expect(new Headers(init.headers).get("User-Agent")).toBe("opencode")
      expect(new Headers(init.headers).get("Accept")).toBe("application/vnd.github+json")
      if (calls.length === 2) gate.resolve()
      if (options.concurrent) await gate.promise
      if (options.transport) throw new Error("synthetic-access-marker synthetic-private-marker")
      return {
        ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
        json: async () => {
          if (options.brokenJSON) throw new Error("synthetic-private-marker")
          return url.endsWith("emails")
            ? (options.emails ?? [{ email: "test@anoma.ly", primary: true, verified: true }])
            : (options.user ?? { id: 123 })
        },
      }
    },
    Database: { use: (fn: (tx: typeof db) => unknown) => fn(db) },
    Account: {
      create: async () => {
        created++
        return "account-test"
      },
    },
    Workspace: {
      create: async () => {
        workspaceCreated++
      },
    },
    User: {
      joinInvitedWorkspaces: async () => {
        joined++
      },
    },
    Actor: { provide: (_type: string, _properties: unknown, fn: () => unknown) => fn() },
    AuthTable: {},
    UserTable: {},
    WorkspaceTable: {},
    Identifier: { create: () => "auth-test" },
    and: () => ({}),
    or: () => ({}),
    eq: () => ({}),
    isNull: () => ({}),
  })
  return {
    run: () => module.default.fetch(new Request("https://auth.example.test/callback"), { AuthStorage: {} }, {}),
    logs,
    calls,
    state: () => ({ selected: selected.length, writes, created, joined, workspaceCreated, issued }),
  }
}

function safeLogs(logs: unknown[][], provider: string, create = false) {
  expect(logs).toEqual([
    [{ event: "auth.provider_callback", provider }],
    ...(create ? [[{ event: "auth.account_create" }]] : []),
  ])
  const text = JSON.stringify(logs)
  for (const marker of ["synthetic-", "test@", "account-test", "123"]) expect(text).not.toContain(marker)
}

describe("production provider callback", () => {
  test("GitHub fetches concurrently, preserves existing account and workspace flow, logs only allowlisted fields", async () => {
    const f = await fixture({ concurrent: true })
    expect((await f.run()).status).toBe(200)
    expect(f.calls).toEqual(["https://api.github.com/user/emails", "https://api.github.com/user"])
    expect(f.state()).toEqual({
      selected: 2,
      writes: 0,
      created: 0,
      joined: 1,
      workspaceCreated: 1,
      issued: ["account", "account-test", { accountID: "account-test", email: "test@anoma.ly", newAccount: false }],
    })
    safeLogs(f.logs, "github")
  })
  test("new account retains linking and newAccount flag without logging identity", async () => {
    const f = await fixture({ existing: false })
    await f.run()
    expect(f.state().created).toBe(1)
    expect(f.state().writes).toBe(1)
    expect(f.state().issued?.[2]).toEqual({ accountID: "account-test", email: "test@anoma.ly", newAccount: true })
    safeLogs(f.logs, "github", true)
  })
  for (const status of [401, 403, 429, 500])
    test(`rejects GitHub HTTP ${status} before database access`, async () => {
      const f = await fixture({ status })
      await expect(f.run()).rejects.toThrow(/^Unable to retrieve GitHub profile$/)
      expect(f.state().selected).toBe(0)
      safeLogs(f.logs, "github")
    })
  for (const options of [{ brokenJSON: true }, { transport: true }])
    test(`sanitizes upstream failure ${JSON.stringify(options)}`, async () => {
      const f = await fixture(options)
      await expect(f.run()).rejects.toThrow(/^Unable to retrieve GitHub profile$/)
      expect(f.state().selected).toBe(0)
      safeLogs(f.logs, "github")
    })
  for (const user of [{}, { id: "123" }, { id: -1 }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }])
    test(`validates GitHub user ${JSON.stringify(user)}`, async () => {
      const f = await fixture({ user })
      await expect(f.run()).rejects.toThrow(/^Invalid GitHub profile$/)
      expect(f.state().selected).toBe(0)
    })
  for (const emails of [
    { message: "private" },
    [null],
    [{ email: "invalid", primary: true, verified: true }],
    [{ email: "test@anoma.ly", primary: "true", verified: true }],
    [{ email: "test@anoma.ly", primary: true, verified: "false" }],
  ])
    test(`validates GitHub emails ${JSON.stringify(emails)}`, async () => {
      const f = await fixture({ emails })
      await expect(f.run()).rejects.toThrow(/^Invalid GitHub profile$/)
      expect(f.state().selected).toBe(0)
    })
  test("retains missing-primary and unverified-primary rejection", async () => {
    for (const [emails, message] of [
      [[], "No primary email found for GitHub user"],
      [[{ email: "test@anoma.ly", primary: true, verified: false }], "Primary email for GitHub user not verified"],
    ] as const) {
      const f = await fixture({ emails })
      await expect(f.run()).rejects.toThrow(message)
      expect(f.state().selected).toBe(0)
    }
  })
  test("retains nonproduction email restriction", async () => {
    const f = await fixture({ stage: "dev", emails: [{ email: "test@example.test", primary: true, verified: true }] })
    await expect(f.run()).rejects.toThrow("Invalid email")
    expect(f.state().selected).toBe(0)
  })
  test("Google existing flow uses no GitHub fetch and logs no claims", async () => {
    const f = await fixture({ provider: "google" })
    await f.run()
    expect(f.calls).toEqual([])
    expect(f.state().issued?.[2]).toEqual({ accountID: "account-test", email: "test@anoma.ly", newAccount: false })
    safeLogs(f.logs, "google")
  })
  test("Google unverified email and unsupported providers remain rejected", async () => {
    const google = await fixture({ provider: "google", verified: false })
    await expect(google.run()).rejects.toThrow("Google email not verified")
    const other = await fixture({ provider: "synthetic-private-marker" })
    await expect(other.run()).rejects.toThrow("Unsupported provider")
    safeLogs(other.logs, "unsupported")
    expect(google.state().selected + other.state().selected).toBe(0)
  })
})
