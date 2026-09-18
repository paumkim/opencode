import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Client } from "@planetscale/database"
import { drizzle } from "drizzle-orm/planetscale-serverless"
import { getTableConfig } from "drizzle-orm/mysql-core"
import { Usage } from "../src/usage"
import { BillingTable, LiteTable, SubscriptionTable, UsageTable } from "../src/schema/billing.sql"
import { UserTable } from "../src/schema/user.sql"
import type { Database as Db } from "../src/drizzle"

// Execute the production MySQL/PlanetScale accounting statements against local
// SQLite, not a test copy of the algorithm. Only dialect/transport are adapted.
// No credentials, database, network, Redis, or SST resource access.
function fixture() {
  const sqlite = new Database(":memory:")
  for (const table of [UsageTable, BillingTable, UserTable, SubscriptionTable, LiteTable]) {
    const config = getTableConfig(table)
    sqlite.exec(
      `CREATE TABLE \`${config.name}\` (${config.columns
        .map((column) => `\`${column.name}\` ${column.getSQLType().includes("int") ? "INTEGER" : "TEXT"}`)
        .join(", ")})`,
    )
  }
  sqlite.exec("INSERT INTO billing (workspace_id, id, balance, monthly_usage) VALUES ('wrk_test', 'bil_test', 1000, 0)")
  sqlite.exec("INSERT INTO user (workspace_id, id, monthly_usage) VALUES ('wrk_test', 'usr_test', 0)")
  const queries: string[] = []
  const client = new Client({
    host: "unused.invalid",
    username: "local-test",
    password: "local-test",
    format: (query, values) => JSON.stringify({ query, values }),
    fetch: async (_url, init) => {
      const encoded: string = JSON.parse(init!.body).query
      const request = encoded.startsWith("{") ? JSON.parse(encoded) : { query: encoded, values: [] }
      queries.push(request.query)
      // Pin "now" so window/reset math is deterministic regardless of wall clock.
      // Rewrite the now()-forms first: their nested parens break the column regexes.
      const query = request.query
        .replace(/MONTH\(now\(\)\)/gi, "9")
        .replace(/YEAR\(now\(\)\)/gi, "2026")
        .replace(/UNIX_TIMESTAMP\(now\(\)\)/gi, String(Math.floor(Date.UTC(2026, 8, 17, 12, 0, 0) / 1000)))
        .replace(/\bnow\(\)/gi, "'2026-09-17 12:00:00'")
        .replace(/MONTH\(([^)]+)\)/gi, "CAST(strftime('%m', $1) AS INTEGER)")
        .replace(/YEAR\(([^)]+)\)/gi, "CAST(strftime('%Y', $1) AS INTEGER)")
        .replace(/UNIX_TIMESTAMP\(([^)]+)\)/gi, "CAST(strftime('%s', $1) AS INTEGER)")
        // Drizzle emits `default` placeholders for unset insert columns. The usage
        // insert must keep them NULL (enrichment, cache columns); only rewrite any
        // remaining defaults after the insert-specific pass.
        .replace(/insert into `usage` \(.*?\) values \(.*?\)/is, (match: string) => match.replace(/\bdefault\b/gi, "NULL"))
        .replace(/\bdefault\b/gi, "CURRENT_TIMESTAMP")
      const values = request.values.map((value: unknown) =>
        typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)
          ? value.replace("T", " ").replace("Z", "")
          : value,
      )
      const rows = (() => {
        try {
          return sqlite.prepare(query).all(...values) as Record<string, string | number | null>[]
        } catch (error) {
          throw new Error(`${error}\ntransformed: ${query}`)
        }
      })()
      const names = rows.length ? Object.keys(rows[0]) : []
      return Response.json({ result: {
        fields: names.map((name) => ({ name, type: "VARCHAR" })),
        rows: rows.map((row) => ({ lengths: names.map((name) => String(String(row[name]).length)), values: btoa(names.map((name) => String(row[name] ?? "")).join("")) })),
        rowsAffected: "0",
      } })
    },
  })
  const db = drizzle({ client })
  return {
    sqlite,
    queries,
    transaction: db.transaction.bind(db),
    state: () => ({
      usage: sqlite.query("SELECT cost, enrichment FROM usage").all(),
      billing: sqlite.query("SELECT balance, monthly_usage FROM billing").get(),
      user: sqlite.query("SELECT monthly_usage FROM user").get(),
      subscription: sqlite.query("SELECT fixed_usage, rolling_usage FROM subscription").get(),
      lite: sqlite.query("SELECT monthly_usage, weekly_usage, rolling_usage FROM lite").get(),
    }),
  }
}

const base = {
  workspaceID: "wrk_test",
  userID: "usr_test",
  keyID: "key_test",
  sessionID: "ses_test",
  model: "grok-code",
  provider: "console",
  usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 },
  cost: 150,
  trackedAt: new Date("2026-09-17T12:00:00Z"),
}

describe("per-request transactional usage accounting", () => {
  test("balance source charges balance once and records the ledger row in one transaction", async () => {
    const f = fixture()
    await f.transaction((tx) =>
      Usage.record(tx, { ...base, source: "balance" }),
    )
    expect(f.state().usage).toEqual([{ cost: 150, enrichment: null }])
    expect(f.state().billing).toEqual({ balance: 850, monthly_usage: 150 })
    expect(f.state().user).toEqual({ monthly_usage: 150 })
    expect(f.queries[0]).toBe("BEGIN")
    expect(f.queries.at(-1)).toBe("COMMIT")
  })

  test.each(["free", "byok"] as const)("%s preserves unbatched semantics: usage totals move, balance does not", async (source) => {
    const f = fixture()
    await f.transaction((tx) => Usage.record(tx, { ...base, source }))
    expect(f.state().billing).toEqual({ balance: 1000, monthly_usage: 150 })
    expect(f.state().user).toEqual({ monthly_usage: 150 })
    expect(f.state().usage).toEqual([{ cost: 150, enrichment: source === "byok" ? '{"plan":"byok"}' : null }])
  })

  test("subscription usage applies fixed and rolling windows without touching balance", async () => {
    const f = fixture()
    f.sqlite.exec("INSERT INTO subscription (workspace_id, id, user_id, fixed_usage, rolling_usage, time_fixed_updated, time_rolling_updated) VALUES ('wrk_test', 'sub_test', 'usr_test', 100, 100, '2026-09-17 11:00:00', '2026-09-17 11:00:00')")
    await f.transaction((tx) =>
      Usage.record(tx, { ...base, source: "subscription", subscription: { plan: "20", rollingWindowSeconds: 5 * 3600 } }),
    )
    expect(f.state().subscription).toEqual({ fixed_usage: 250, rolling_usage: 250 })
    expect(f.state().billing).toEqual({ balance: 1000, monthly_usage: 0 })
    expect(f.state().usage).toEqual([{ cost: 150, enrichment: '{"plan":"sub"}' }])
  })

  test("lite usage applies the quota multiplier without touching balance", async () => {
    const f = fixture()
    f.sqlite.exec("INSERT INTO lite (workspace_id, id, user_id, monthly_usage, weekly_usage, rolling_usage, time_monthly_updated, time_weekly_updated, time_rolling_updated, time_created) VALUES ('wrk_test', 'lit_test', 'usr_test', 0, 0, 0, '2026-09-01 00:00:00', '2026-09-01 00:00:00', '2026-09-01 00:00:00', '2026-09-01 00:00:00')")
    await f.transaction((tx) =>
      Usage.record(tx, { ...base, source: "lite", costMultiplier: 2, lite: { rollingWindowSeconds: 5 * 3600, quotaCost: 300, timeCreated: new Date("2026-09-01T00:00:00Z") } }),
    )
    expect(f.state().lite).toEqual({ monthly_usage: 300, weekly_usage: 300, rolling_usage: 300 })
    expect(f.state().billing).toEqual({ balance: 1000, monthly_usage: 0 })
    expect(f.state().usage).toEqual([{ cost: 150, enrichment: '{"plan":"lite","costMultiplier":2}' }])
  })

  test("monthly totals reset across a month boundary like the unbatched path", async () => {
    const f = fixture()
    f.sqlite.exec("UPDATE billing SET monthly_usage = 500, time_monthly_usage_updated = '2026-08-15 00:00:00'")
    f.sqlite.exec("UPDATE user SET monthly_usage = 500, time_monthly_usage_updated = '2026-08-15 00:00:00'")
    await f.transaction((tx) => Usage.record(tx, { ...base, source: "balance" }))
    expect(f.state().billing).toEqual({ balance: 850, monthly_usage: 150 })
    expect(f.state().user).toEqual({ monthly_usage: 150 })
  })

  test("a failed accounting write rolls back the ledger row and every total", async () => {
    const f = fixture()
    await expect(
      f.transaction(async (tx) => {
        await Usage.record(tx, { ...base, source: "balance" })
        throw new Error("user write failed")
      }),
    ).rejects.toThrow("user write failed")
    expect(f.state().usage).toEqual([])
    expect(f.state().billing).toEqual({ balance: 1000, monthly_usage: 0 })
    expect(f.state().user).toEqual({ monthly_usage: 0 })
    expect(f.queries.at(-1)).toBe("ROLLBACK")
  })
})
