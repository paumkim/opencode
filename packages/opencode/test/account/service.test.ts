import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Duration, Effect, Layer, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http"

import { AccountRepo } from "../../src/account/repo"
import { Account } from "../../src/account/account"
import {
  AccessToken,
  AccountID,
  AccountServiceError,
  AccountTransportError,
  DeviceCode,
  Login,
  Org,
  OrgID,
  RefreshToken,
  UserCode,
} from "../../src/account/schema"
import { Database } from "@opencode-ai/core/database/database"
import { testEffect } from "../lib/effect"

const truncate = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`DELETE FROM account_state`)
    yield* db.run(sql`DELETE FROM account`)
  }),
)
const truncateNode = LayerNode.make({ name: "truncate-account", layer: truncate, deps: [Database.node] })

const it = testEffect(LayerNode.compile(LayerNode.group([AccountRepo.node, truncateNode])))

const insideEagerRefreshWindow = Duration.toMillis(Duration.minutes(1))
const outsideEagerRefreshWindow = Duration.toMillis(Duration.minutes(10))

const live = (client: HttpClient.HttpClient) =>
  LayerNode.compile(Account.node, [[httpClient, Layer.succeed(HttpClient.HttpClient, client)]])

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const encodeOrg = Schema.encodeSync(Org)

const org = (id: string, name: string) => encodeOrg(new Org({ id: OrgID.make(id), name }))

const login = () =>
  new Login({
    code: DeviceCode.make("device-code"),
    user: UserCode.make("user-code"),
    url: "https://one.example.com/verify",
    server: "https://one.example.com",
    expiry: Duration.seconds(600),
    interval: Duration.seconds(5),
  })

const deviceTokenClient = (body: unknown, status = 400) =>
  HttpClient.make((req) =>
    Effect.succeed(
      req.url === "https://one.example.com/auth/device/token" ? json(req, body, status) : json(req, {}, 404),
    ),
  )

const poll = (body: unknown, status = 400) =>
  Account.Service.use((s) => s.poll(login())).pipe(Effect.provide(live(deviceTokenClient(body, status))))

it.live("login resolves origin-rooted verification URLs from servers with base paths", () =>
  Effect.gen(function* () {
    const seen: Array<string> = []
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        seen.push(`${req.method} ${req.url}`)

        if (req.url === "https://one.example.com/console/auth/device/code") {
          return json(req, {
            device_code: "device-code",
            user_code: "user-code",
            verification_uri_complete: "/console/device?user_code=user-code",
            expires_in: 600,
            interval: 5,
          })
        }

        return json(req, {}, 404)
      }),
    )

    const result = yield* Account.use.login("https://one.example.com/console/").pipe(Effect.provide(live(client)))

    expect(seen).toEqual(["POST https://one.example.com/console/auth/device/code"])
    expect(result.server).toBe("https://one.example.com/console")
    expect(result.url).toBe("https://one.example.com/console/device?user_code=user-code")
  }),
)

it.live("login rejects malformed device verification URLs", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((req) =>
      Effect.succeed(
        json(req, {
          device_code: "device-code",
          user_code: "user-code",
          verification_uri_complete: "http://[::1",
          expires_in: 600,
          interval: 5,
        }),
      ),
    )

    const error = yield* Effect.flip(Account.use.login("https://one.example.com").pipe(Effect.provide(live(client))))
    expect(error).toBeInstanceOf(AccountServiceError)
    if (error instanceof AccountServiceError) expect(error.message).toBe("Invalid device verification URL")
  }),
)

it.live("login maps transport failures to account transport errors", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((req) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request: req }),
        }),
      ),
    )

    const error = yield* Effect.flip(Account.use.login("https://one.example.com").pipe(Effect.provide(live(client))))

    expect(error).toBeInstanceOf(AccountTransportError)
    if (error instanceof AccountTransportError) {
      expect(error.method).toBe("POST")
      expect(error.url).toBe("https://one.example.com/auth/device/code")
    }
  }),
)

it.live("orgsByAccount groups orgs per account", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: AccountID.make("user-1"),
        email: "one@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: AccountID.make("user-2"),
        email: "two@example.com",
        url: "https://two.example.com",
        accessToken: AccessToken.make("at_2"),
        refreshToken: RefreshToken.make("rt_2"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    const seen: Array<string> = []
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        seen.push(`${req.method} ${req.url}`)

        if (req.url === "https://one.example.com/api/orgs") {
          return json(req, [org("org-1", "One")])
        }

        if (req.url === "https://two.example.com/api/orgs") {
          return json(req, [org("org-2", "Two A"), org("org-3", "Two B")])
        }

        return json(req, [], 404)
      }),
    )

    const rows = yield* Account.use.orgsByAccount().pipe(Effect.provide(live(client)))

    expect(rows.groups.map((row) => [row.account.id, row.orgs.map((org) => org.id)]).map(([id, orgs]) => [id, orgs])).toEqual([
      [AccountID.make("user-1"), [OrgID.make("org-1")]],
      [AccountID.make("user-2"), [OrgID.make("org-2"), OrgID.make("org-3")]],
    ])
    expect(seen).toEqual(["GET https://one.example.com/api/orgs", "GET https://two.example.com/api/orgs"])
  }),
)

it.live("remove switches to another org when the active account is removed", () =>
  Effect.gen(function* () {
    const first = AccountID.make("user-1")
    const second = AccountID.make("user-2")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: first,
        email: "one@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: second,
        email: "two@example.com",
        url: "https://two.example.com",
        accessToken: AccessToken.make("at_2"),
        refreshToken: RefreshToken.make("rt_2"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.some(OrgID.make("org-2")),
      }),
    )

    const client = HttpClient.make((req) =>
      Effect.succeed(
        req.url === "https://one.example.com/api/orgs" ? json(req, [org("org-1", "One")]) : json(req, [], 404),
      ),
    )

    yield* Account.use.remove(second).pipe(Effect.provide(live(client)))

    const active = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active)).toEqual(
      expect.objectContaining({
        id: first,
        active_org_id: OrgID.make("org-1"),
      }),
    )
  }),
)

it.live("token refresh persists the new token", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_old"),
        refreshToken: RefreshToken.make("rt_old"),
        expiry: Date.now() - 1_000,
        orgID: Option.none(),
      }),
    )

    const client = HttpClient.make((req) =>
      Effect.succeed(
        req.url === "https://one.example.com/auth/device/token"
          ? json(req, {
              access_token: "at_new",
              refresh_token: "rt_new",
              expires_in: 60,
            })
          : json(req, {}, 404),
      ),
    )

    const token = yield* Account.use.token(id).pipe(Effect.provide(live(client)))

    expect(Option.getOrThrow(token)).toBeDefined()
    expect(String(Option.getOrThrow(token))).toBe("at_new")

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("at_new"))
    expect(value.refresh_token).toBe(RefreshToken.make("rt_new"))
    expect(value.token_expiry).toBeGreaterThan(Date.now())
  }),
)

it.live("token refreshes before expiry when inside the eager refresh window", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_old"),
        refreshToken: RefreshToken.make("rt_old"),
        expiry: Date.now() + insideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    let refreshCalls = 0
    const client = HttpClient.make((req) =>
      Effect.promise(async () => {
        if (req.url === "https://one.example.com/auth/device/token") {
          refreshCalls += 1
          return json(req, {
            access_token: "at_new",
            refresh_token: "rt_new",
            expires_in: 60,
          })
        }

        return json(req, {}, 404)
      }),
    )

    const token = yield* Account.use.token(id).pipe(Effect.provide(live(client)))

    expect(String(Option.getOrThrow(token))).toBe("at_new")
    expect(refreshCalls).toBe(1)

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("at_new"))
    expect(value.refresh_token).toBe(RefreshToken.make("rt_new"))
  }),
)

it.live("concurrent config and token requests coalesce token refresh", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_old"),
        refreshToken: RefreshToken.make("rt_old"),
        expiry: Date.now() - 1_000,
        orgID: Option.some(OrgID.make("org-9")),
      }),
    )

    let refreshCalls = 0
    const client = HttpClient.make((req) =>
      Effect.promise(async () => {
        if (req.url === "https://one.example.com/auth/device/token") {
          refreshCalls += 1

          if (refreshCalls === 1) {
            await new Promise((resolve) => setTimeout(resolve, 25))
            return json(req, {
              access_token: "at_new",
              refresh_token: "rt_new",
              expires_in: 60,
            })
          }

          return json(
            req,
            {
              error: "invalid_grant",
              error_description: "refresh token already used",
            },
            400,
          )
        }

        if (req.url === "https://one.example.com/api/config") {
          return json(req, { config: { theme: "light", seats: 5 } })
        }

        return json(req, {}, 404)
      }),
    )

    const [cfg, token] = yield* Account.Service.use((s) =>
      Effect.all([s.config(id, OrgID.make("org-9")), s.token(id)], { concurrency: 2 }),
    ).pipe(Effect.provide(live(client)))

    expect(Option.getOrThrow(cfg)).toEqual({ theme: "light", seats: 5 })
    expect(String(Option.getOrThrow(token))).toBe("at_new")
    expect(refreshCalls).toBe(1)

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("at_new"))
    expect(value.refresh_token).toBe(RefreshToken.make("rt_new"))
  }),
)

it.live("config sends the selected org header", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "user@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    const seen: { auth?: string; org?: string } = {}
    const client = HttpClient.make((req) =>
      Effect.gen(function* () {
        seen.auth = req.headers.authorization
        seen.org = req.headers["x-org-id"]

        if (req.url === "https://one.example.com/api/config") {
          return json(req, { config: { theme: "light", seats: 5 } })
        }

        return json(req, {}, 404)
      }),
    )

    const cfg = yield* Account.Service.use((s) => s.config(id, OrgID.make("org-9"))).pipe(Effect.provide(live(client)))

    expect(Option.getOrThrow(cfg)).toEqual({ theme: "light", seats: 5 })
    expect(seen).toEqual({
      auth: "Bearer at_1",
      org: "org-9",
    })
  }),
)

it.live("poll stores the account and first org on success", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((req) =>
      Effect.succeed(
        req.url === "https://one.example.com/auth/device/token"
          ? json(req, {
              access_token: "at_1",
              refresh_token: "rt_1",
              token_type: "Bearer",
              expires_in: 60,
            })
          : req.url === "https://one.example.com/api/user"
            ? json(req, { id: "user-1", email: "user@example.com" })
            : req.url === "https://one.example.com/api/orgs"
              ? json(req, [org("org-1", "One")])
              : json(req, {}, 404),
      ),
    )

    const res = yield* Account.Service.use((s) => s.poll(login())).pipe(Effect.provide(live(client)))

    expect(res._tag).toBe("PollSuccess")
    if (res._tag === "PollSuccess") {
      expect(res.email).toBe("user@example.com")
    }

    const active = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active)).toEqual(
      expect.objectContaining({
        id: "user-1",
        email: "user@example.com",
        active_org_id: "org-1",
      }),
    )
  }),
)

for (const [name, body, expectedTag] of [
  [
    "pending",
    {
      error: "authorization_pending",
      error_description: "The authorization request is still pending",
    },
    "PollPending",
  ],
  [
    "slow",
    {
      error: "slow_down",
      error_description: "Polling too frequently, please slow down",
    },
    "PollSlow",
  ],
  [
    "denied",
    {
      error: "access_denied",
      error_description: "The authorization request was denied",
    },
    "PollDenied",
  ],
  [
    "expired",
    {
      error: "expired_token",
      error_description: "The device code has expired",
    },
    "PollExpired",
  ],
] as const) {
  it.live(`poll returns ${name} for ${body.error}`, () =>
    Effect.gen(function* () {
      const result = yield* poll(body)
      expect(result._tag).toBe(expectedTag)
    }),
  )
}

it.live("poll returns poll error for other OAuth errors", () =>
  Effect.gen(function* () {
    const result = yield* poll({
      error: "server_error",
      error_description: "An unexpected error occurred",
    })

    expect(result._tag).toBe("PollError")
    if (result._tag === "PollError") {
      expect(String(result.cause)).toContain("server_error")
    }
  }),
)

it.live("a failed org read is not reported as an account with no orgs", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: AccountID.make("user-1"),
        email: "one@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    // The regression: the per-account catch answered a failed read with `[]`, which is not a
    // neutral placeholder. It claims the account has no orgs, and every caller acts on that
    // claim - `account orgs` printed "No orgs found", `account switch` refused to open a picker,
    // and the console route answered `switchableOrgCount: 0` so the TUI's Switch org command
    // disappeared. It also made the two HTTP handlers that wrap this call in
    // `Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))` unreachable:
    // they were written to report exactly this and could never see it.
    const client = HttpClient.make((req) =>
      Effect.succeed(json(req, { message: "upstream exploded" }, 500)),
    )

    const result = yield* Account.use.orgsByAccount().pipe(Effect.provide(live(client)))
    // The account is in `failures`, not in `groups` with an empty org list. An entry with `orgs: []`
    // is indistinguishable from an account that genuinely has no orgs, and that is the claim every
    // caller acted on.
    expect(result.groups).toEqual([])
    expect(result.failures.map((f) => f.accountID)).toEqual([AccountID.make("user-1")])
    expect(result.failures[0]?.error._tag).toBe("AccountServiceError")
  }),
)

it.live("an account that really has no orgs still reads as empty rather than failing", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: AccountID.make("user-empty"),
        email: "empty@example.com",
        url: "https://empty.example.com",
        accessToken: AccessToken.make("at_e"),
        refreshToken: RefreshToken.make("rt_e"),
        expiry: Date.now() + outsideEagerRefreshWindow,
        orgID: Option.none(),
      }),
    )

    // The other direction, and the one a remove-the-catch change could easily break. A healthy
    // server answering `[]` is the absence of orgs, not a failure, and conflating the two would
    // make every orgless account look broken.
    const client = HttpClient.make((req) => Effect.succeed(json(req, [])))
    const result = yield* Account.use.orgsByAccount().pipe(Effect.provide(live(client)))
    expect(result.groups.map((row) => row.orgs.length)).toEqual([0])
    expect(result.failures).toEqual([])
  }),
)

it.live("an unreadable account does not block removing another one", () =>
  Effect.gen(function* () {
    const first = AccountID.make("user-1")
    const second = AccountID.make("user-2")

    for (const account of [
      { id: first, email: "one@example.com", url: "https://one.example.com", token: "at_1" },
      { id: second, email: "two@example.com", url: "https://two.example.com", token: "at_2" },
    ]) {
      yield* AccountRepo.Service.use((r) =>
        r.persistAccount({
          id: account.id,
          email: account.email,
          url: account.url,
          accessToken: AccessToken.make(account.token),
          refreshToken: RefreshToken.make("rt"),
          expiry: Date.now() + outsideEagerRefreshWindow,
          orgID: Option.some(OrgID.make("org-1")),
        }),
      )
    }
    yield* AccountRepo.Service.use((r) => r.use(second, Option.some(OrgID.make("org-1"))))

    // The behaviour the old blanket catch was accidentally providing. It got there by answering a
    // failed read with `[]`, which also made the listing lie - so the capability was real and the
    // reason it worked was a defect. It is preserved deliberately here, and it is preserved for a
    // different reason: the account being removed is being discarded anyway, and the fallback only
    // needs *some* readable account to switch to.
    const client = HttpClient.make((req) =>
      Effect.succeed(
        req.url === "https://one.example.com/api/orgs"
          ? json(req, [org("org-1", "One")])
          : json(req, { message: "down" }, 500),
      ),
    )

    yield* Account.use.remove(second).pipe(Effect.provide(live(client)))

    const remaining = yield* AccountRepo.Service.use((r) => r.list())
    expect(remaining.map((a) => a.id)).toEqual([first])
    const active = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active).id).toEqual(first)
  }),
)

it.live("one broken account does not empty the others' orgs, and is named in failures", () =>
  Effect.gen(function* () {
    for (const account of [
      { id: "user-ok", email: "ok@example.com", url: "https://ok.example.com", token: "at_ok" },
      { id: "user-bad", email: "bad@example.com", url: "https://bad.example.com", token: "at_bad" },
    ]) {
      yield* AccountRepo.Service.use((r) =>
        r.persistAccount({
          id: AccountID.make(account.id),
          email: account.email,
          url: account.url,
          accessToken: AccessToken.make(account.token),
          refreshToken: RefreshToken.make("rt"),
          expiry: Date.now() + outsideEagerRefreshWindow,
          orgID: Option.none(),
        }),
      )
    }

    // Why this test exists at all: the first attempt at this fix propagated the failure, and it
    // broke a real capability - `opencode account orgs` would show nothing at all because one
    // account's endpoint was down, and removing an unrelated account would refuse outright. A
    // per-account fan-out wants partial data that is *labelled*, not data that is discarded and not
    // a total failure.
    const client = HttpClient.make((req) =>
      Effect.succeed(
        req.url === "https://ok.example.com/api/orgs"
          ? json(req, [org("org-ok", "Ok Org")])
          : json(req, { message: "upstream exploded" }, 500),
      ),
    )

    const result = yield* Account.use.orgsByAccount().pipe(Effect.provide(live(client)))
    // The readable account is still reported, in full.
    expect(result.groups.map((row) => [row.account.id, row.orgs.map((o) => o.id)])).toEqual([
      [AccountID.make("user-ok"), [OrgID.make("org-ok")]],
    ])
    // And the unreadable one is named rather than reported as having no orgs.
    expect(result.failures.map((f) => f.accountID)).toEqual([AccountID.make("user-bad")])
    expect(result.failures[0]?.error._tag).toBe("AccountServiceError")
  }),
)
