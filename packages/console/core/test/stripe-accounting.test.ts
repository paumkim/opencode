import { afterEach, describe, expect, mock, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Client } from "@planetscale/database"
import { drizzle } from "drizzle-orm/planetscale-serverless"
import { getTableConfig } from "drizzle-orm/mysql-core"
import { BillingTable, PaymentTable } from "../src/schema/billing.sql"
// Bun module mocks are process-wide: run this suite from console/core, not
// together with app/function suites. Never read caller-provided SST links.
mock.module("@opencode-ai/console-resource", () => ({
  Resource: {
    ZEN_LITE_PRICE: {
      firstMonth100Coupon: "coupon_test_1m100",
      firstMonth50Coupon: "coupon_test_1m50",
      threeMonths100Coupon: "coupon_test_3m100",
      sixMonths100Coupon: "coupon_test_6m100",
      twelveMonths100Coupon: "coupon_test_12m100",
    },
    STRIPE_SECRET_KEY: { value: "sk_test_inert_not_a_credential" },
  },
}))
// Install the resource boundary before evaluating billing -> lite. Database
// transport and Stripe calls below are local fakes; production logic is real.
const { StripeAccounting } = await import("../src/stripe-accounting")
const { Billing } = await import("../src/billing")
import { Actor } from "../src/actor"
import { centsToMicroCents } from "../src/util/price"
import type { Stripe } from "stripe"

const databases: Database[] = []
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
})

// Execute the production MySQL/PlanetScale queries against local SQLite, not a
// test copy of the accounting algorithm. Only dialect/transport are adapted.
// This verifies real constraints and rollback, NOT MySQL lock/wait semantics.
async function fixture() {
  const sqlite = new Database(":memory:")
  databases.push(sqlite)
  const migration = await Bun.file(
    new URL("../migrations/20260917121347_stripe_event_idempotency/migration.sql", import.meta.url),
  ).text()
  sqlite.exec(migration.replace("(now())", "CURRENT_TIMESTAMP"))
  for (const table of [BillingTable, PaymentTable]) {
    const config = getTableConfig(table)
    sqlite.exec(
      `CREATE TABLE \`${config.name}\` (${config.columns
        .map((column) => `\`${column.name}\` ${column.getSQLType().includes("int") ? "INTEGER" : "TEXT"}`)
        .join(", ")}, PRIMARY KEY (workspace_id, id))`,
    )
  }
  sqlite.exec(
    "CREATE TABLE stripe_operation (operation_id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, time_created TEXT)",
  )
  sqlite.exec("CREATE TABLE coupon (email TEXT, type TEXT, time_redeemed TEXT, PRIMARY KEY (email, type))")
  sqlite.exec("INSERT INTO billing (workspace_id, id, balance) VALUES ('wrk_test', 'bil_test', 0)")
  const queries: string[] = []
  const client = new Client({
    host: "unused.invalid",
    username: "local-test",
    password: "local-test",
    // Preserve bound values instead of applying MySQL string escaping to SQLite.
    format: (query, values) => JSON.stringify({ query, values }),
    // No network: the actual PlanetScale driver's BEGIN/COMMIT/ROLLBACK and
    // Drizzle SQL all go through this local transport.
    fetch: async (_url, init) => {
      const encoded: string = JSON.parse(init!.body).query
      const request: { query: string; values: (string | number | null)[] } = encoded.startsWith("{")
        ? JSON.parse(encoded)
        : { query: encoded, values: [] }
      const original = request.query
      queries.push(original)
      const query = original
        .replace(/ for update$/i, "")
        .replace(
          /on duplicate key update/i,
          `on conflict(${original.includes("`stripe_operation`") ? "operation_id" : original.includes("`coupon`") ? "email, type" : "event_id"}) do update set`,
        )
        .replace(/\bdefault\b/gi, original.startsWith("insert into `stripe_event`") ? "CURRENT_TIMESTAMP" : "null")
        // MySQL now() in runtime expressions (e.g. coupon time_redeemed).
        .replace(/\bnow\(\)/gi, "CURRENT_TIMESTAMP")
      const statement = sqlite.prepare(query)
      const rows = statement.all(...request.values) as Record<string, string | number | null>[]
      const names = rows.length ? Object.keys(rows[0]) : []
      return new Response(
        JSON.stringify({
          result: {
            fields: names.map((name) => ({
              name,
              type: name === "enrichment" ? "JSON" : typeof rows[0][name] === "number" ? "INT64" : "VARCHAR",
            })),
            rows: rows.map((row) => ({
              lengths: names.map((name) => (row[name] === null ? "-1" : String(String(row[name]).length))),
              values: btoa(names.map((name) => row[name] ?? "").join("")),
            })),
            rowsAffected: "0", // Claim ownership must not depend on this driver-specific count.
          },
        }),
      )
    },
  })
  const db = drizzle({ client })
  return {
    sqlite,
    queries,
    transaction: db.transaction.bind(db),
    state: () => ({
      balance: sqlite.query("SELECT balance FROM billing").get(),
      payments: sqlite.query("SELECT amount, time_refunded, enrichment FROM payment ORDER BY amount").all(),
      events: sqlite.query("SELECT event_id FROM stripe_event ORDER BY event_id").all(),
      coupons: sqlite.query("SELECT email, type, time_redeemed FROM coupon ORDER BY email").all(),
    }),
  }
}

const payment = {
  workspaceID: "wrk_test",
  customerID: "cus_test",
  paymentID: "pi_test",
  amount: centsToMicroCents(100),
}

describe("Stripe webhook accounting", () => {
  test("repeated top-up delivery commits one balance credit and one payment", async () => {
    const db = await fixture()
    expect(await StripeAccounting.payment("evt_topup", payment, {}, db.transaction)).toBe("processed")
    const committed = db.state()
    expect(await StripeAccounting.payment("evt_topup", payment, {}, db.transaction)).toBe("duplicate")
    expect(db.state()).toEqual(committed)
    expect(committed.balance).toEqual({ balance: centsToMicroCents(100) })
    expect(committed.payments).toHaveLength(1)
    expect(committed.events).toEqual([{ event_id: "evt_topup" }])
    expect(db.queries.filter((query) => query.includes("on duplicate key update"))).toHaveLength(3)
    expect(db.queries.filter((query) => query.endsWith("for update"))).toHaveLength(5)
  })

  test("payment insert failure rolls back both the preceding balance credit and claim; retry succeeds", async () => {
    const db = await fixture()
    db.sqlite.exec("CREATE TRIGGER fail_payment BEFORE INSERT ON payment BEGIN SELECT RAISE(ABORT, 'injected'); END")
    await expect(StripeAccounting.payment("evt_retry", payment, {}, db.transaction)).rejects.toThrow()
    expect(db.state()).toEqual({ balance: { balance: 0 }, payments: [], events: [], coupons: [] })
    expect(db.queries).toContain("ROLLBACK")
    db.sqlite.exec("DROP TRIGGER fail_payment")
    expect(await StripeAccounting.payment("evt_retry", payment, {}, db.transaction)).toBe("processed")
    expect(db.state().balance).toEqual({ balance: centsToMicroCents(100) })
    expect(db.state().payments).toHaveLength(1)
  })

  test("distinct successful events are not suppressed", async () => {
    const db = await fixture()
    await StripeAccounting.payment("evt_one", payment, {}, db.transaction)
    await StripeAccounting.payment(
      "evt_two",
      { ...payment, paymentID: "pi_two", amount: centsToMicroCents(250) },
      {},
      db.transaction,
    )
    expect(db.state().balance).toEqual({ balance: centsToMicroCents(350) })
    expect(db.state().payments).toHaveLength(2)
    expect(db.state().events).toHaveLength(2)
  })

  test("subscription invoice retry records one payment without crediting balance", async () => {
    const db = await fixture()
    const subscription = { ...payment, enrichment: { type: "lite" as const, couponID: "coupon_test" } }
    await StripeAccounting.payment("evt_subscription", subscription, undefined, db.transaction)
    await StripeAccounting.payment("evt_subscription", subscription, undefined, db.transaction)
    expect(db.state().balance).toEqual({ balance: 0 })
    expect(db.state().payments).toEqual([
      { amount: centsToMicroCents(100), time_refunded: null, enrichment: JSON.stringify(subscription.enrichment) },
    ])
  })

  test("repeated refund delivery debits top-up balance only once", async () => {
    const db = await fixture()
    await StripeAccounting.payment("evt_payment", payment, {}, db.transaction)
    const refund = {
      workspaceID: payment.workspaceID,
      paymentID: payment.paymentID,
      timeRefunded: new Date(0),
      refundedCents: 1,
      chargedCents: 1,
    }
    expect(await StripeAccounting.refund("evt_refund", refund, db.transaction)).toBe("processed")
    const committed = db.state()
    expect(await StripeAccounting.refund("evt_refund", refund, db.transaction)).toBe("duplicate")
    expect(db.state()).toEqual(committed)
    expect(committed.balance).toEqual({ balance: 0 })
    expect(committed.payments[0]).toMatchObject({ time_refunded: "1970-01-01 00:00:00.000" })
  })

  test("refund debit failure rolls back the refund timestamp and claim, then retries", async () => {
    const db = await fixture()
    await StripeAccounting.payment("evt_payment", payment, {}, db.transaction)
    const before = db.state()
    const refund = {
      workspaceID: payment.workspaceID,
      paymentID: payment.paymentID,
      timeRefunded: new Date(0),
      refundedCents: 1,
      chargedCents: 1,
    }
    db.sqlite.exec("CREATE TRIGGER fail_debit BEFORE UPDATE ON billing BEGIN SELECT RAISE(ABORT, 'injected'); END")
    await expect(StripeAccounting.refund("evt_refund", refund, db.transaction)).rejects.toThrow()
    expect(db.state()).toEqual(before)
    db.sqlite.exec("DROP TRIGGER fail_debit")
    await StripeAccounting.refund("evt_refund", refund, db.transaction)
    expect(db.state().balance).toEqual({ balance: 0 })
    expect(db.state().events).toHaveLength(2)
  })

  test("missing payment does not consume a refund event", async () => {
    const db = await fixture()
    const refund = {
      workspaceID: payment.workspaceID,
      paymentID: payment.paymentID,
      timeRefunded: new Date(0),
      refundedCents: 1,
      chargedCents: 1,
    }
    await expect(StripeAccounting.refund("evt_refund", refund, db.transaction)).rejects.toThrow("Payment not found")
    expect(db.state().events).toHaveLength(0)
    await StripeAccounting.payment("evt_payment", payment, {}, db.transaction)
    await StripeAccounting.refund("evt_refund", refund, db.transaction)
    expect(db.state().balance).toEqual({ balance: 0 })
  })

  test("subscription refund marks the payment without debiting balance", async () => {
    const db = await fixture()
    await StripeAccounting.payment(
      "evt_payment",
      { ...payment, enrichment: { type: "subscription" } },
      undefined,
      db.transaction,
    )
    await StripeAccounting.refund(
      "evt_refund",
      {
        workspaceID: payment.workspaceID,
        paymentID: payment.paymentID,
        timeRefunded: new Date(0),
        refundedCents: 1,
        chargedCents: 1,
      },
      db.transaction,
    )
    expect(db.state().balance).toEqual({ balance: 0 })
    expect(db.state().payments[0]).toMatchObject({ time_refunded: "1970-01-01 00:00:00.000" })
  })

  test("same invoice across distinct events records one credit", async () => {
    const db = await fixture()
    await StripeAccounting.payment("evt_first", { ...payment, invoiceID: "in_test" }, {}, db.transaction)
    await StripeAccounting.payment("evt_second", { ...payment, invoiceID: "in_test" }, {}, db.transaction)
    expect(db.state().balance).toEqual({ balance: centsToMicroCents(100) })
    expect(db.state().payments).toHaveLength(1)
    expect(db.state().events).toHaveLength(2)
  })

  test("same payment intent across distinct events records one credit", async () => {
    const db = await fixture()
    await StripeAccounting.payment("evt_first", { ...payment, invoiceID: "in_test" }, {}, db.transaction)
    // Same intent, no invoice alias: the row-level match must catch it even
    // though the operation keys differ.
    await StripeAccounting.payment("evt_second", { ...payment }, {}, db.transaction)
    expect(db.state().balance).toEqual({ balance: centsToMicroCents(100) })
    expect(db.state().payments).toHaveLength(1)
  })

  test("distinct invoices on one payment intent both credit", async () => {
    const db = await fixture()
    await StripeAccounting.payment("evt_first", { ...payment, invoiceID: "in_one" }, {}, db.transaction)
    await StripeAccounting.payment("evt_second", { ...payment, invoiceID: "in_two" }, {}, db.transaction)
    expect(db.state().balance).toEqual({ balance: centsToMicroCents(200) })
    expect(db.state().payments).toHaveLength(2)
  })

  test("partial refunds debit only the refunded credit incrementally", async () => {
    const db = await fixture()
    await StripeAccounting.payment("evt_payment", payment, {}, db.transaction)
    // Stripe's amount_refunded is cumulative, not per-event.
    await StripeAccounting.refund(
      "evt_refund_one",
      {
        workspaceID: payment.workspaceID,
        paymentID: payment.paymentID,
        timeRefunded: new Date(0),
        refundedCents: 40,
        chargedCents: 100,
      },
      db.transaction,
    )
    expect(db.state().balance).toEqual({ balance: centsToMicroCents(60) })
    await StripeAccounting.refund(
      "evt_refund_two",
      {
        workspaceID: payment.workspaceID,
        paymentID: payment.paymentID,
        timeRefunded: new Date(0),
        refundedCents: 100,
        chargedCents: 100,
      },
      db.transaction,
    )
    expect(db.state().balance).toEqual({ balance: 0 })
    expect(db.state().payments[0]).toMatchObject({ time_refunded: "1970-01-01 00:00:00.000" })
  })

  test("out-of-order partial refunds never over-debit balance", async () => {
    const db = await fixture()
    await StripeAccounting.payment("evt_payment", payment, {}, db.transaction)
    await StripeAccounting.refund(
      "evt_refund_late",
      {
        workspaceID: payment.workspaceID,
        paymentID: payment.paymentID,
        timeRefunded: new Date(0),
        refundedCents: 100,
        chargedCents: 100,
      },
      db.transaction,
    )
    await StripeAccounting.refund(
      "evt_refund_early",
      {
        workspaceID: payment.workspaceID,
        paymentID: payment.paymentID,
        timeRefunded: new Date(0),
        refundedCents: 40,
        chargedCents: 100,
      },
      db.transaction,
    )
    expect(db.state().balance).toEqual({ balance: 0 })
  })

  test("zero cumulative refund does not debit balance or mark a payment refunded", async () => {
    const db = await fixture()
    await StripeAccounting.payment("evt_payment", payment, {}, db.transaction)
    await StripeAccounting.refund(
      "evt_refund_fee",
      {
        workspaceID: payment.workspaceID,
        paymentID: payment.paymentID,
        timeRefunded: new Date(0),
        refundedCents: 0,
        chargedCents: 100,
      },
      db.transaction,
    )
    expect(db.state().balance).toEqual({ balance: centsToMicroCents(100) })
    expect(db.state().payments[0]).toMatchObject({ time_refunded: null })
  })

  test("legacy refunded rows are treated as fully reversed", async () => {
    const db = await fixture()
    await StripeAccounting.payment("evt_payment", payment, {}, db.transaction)
    db.sqlite.exec("UPDATE payment SET refunded_amount = NULL, time_refunded = '2020-01-01 00:00:00.000'")
    await StripeAccounting.refund(
      "evt_refund_partial",
      {
        workspaceID: payment.workspaceID,
        paymentID: payment.paymentID,
        timeRefunded: new Date(0),
        refundedCents: 50,
        chargedCents: 100,
      },
      db.transaction,
    )
    expect(db.state().balance).toEqual({ balance: centsToMicroCents(100) })
  })

  test("ambiguous duplicate payment rows fail closed without debiting", async () => {
    const db = await fixture()
    await StripeAccounting.payment("evt_payment", payment, {}, db.transaction)
    db.sqlite.exec(
      `INSERT INTO payment (workspace_id, id, customer_id, invoice_id, payment_id, amount) VALUES ('wrk_test', 'pay_dup', 'cus_test', 'in_test', 'pi_test', ${centsToMicroCents(100)})`,
    )
    await expect(
      StripeAccounting.refund(
        "evt_refund",
        {
          workspaceID: payment.workspaceID,
          paymentID: payment.paymentID,
          timeRefunded: new Date(0),
          refundedCents: 100,
          chargedCents: 100,
        },
        db.transaction,
      ),
    ).rejects.toThrow("Ambiguous payment refund")
    expect(db.state().balance).toEqual({ balance: centsToMicroCents(100) })
    expect(db.state().events).toHaveLength(1)
  })

  test("shared intent allocates cumulative refunds by invoice, survives rollback, replay and late invoices", async () => {
    const db = await fixture()
    await StripeAccounting.payment("evt_b", { ...payment, invoiceID: "in_b" }, {}, db.transaction)
    await StripeAccounting.payment("evt_a", { ...payment, invoiceID: "in_a" }, {}, db.transaction)
    const input = {
      workspaceID: payment.workspaceID,
      paymentID: payment.paymentID,
      timeRefunded: new Date(1000),
      refundedCents: 150,
      chargedCents: 350,
    }
    const allocations = () =>
      db.sqlite.query("SELECT invoice_id, refunded_amount FROM payment ORDER BY invoice_id").all()
    db.sqlite.exec("CREATE TRIGGER fail_debit BEFORE UPDATE ON billing BEGIN SELECT RAISE(ABORT, 'injected'); END")
    await expect(StripeAccounting.refund("evt_partial", input, db.transaction)).rejects.toThrow()
    expect(allocations()).toEqual([
      { invoice_id: "in_a", refunded_amount: 0 },
      { invoice_id: "in_b", refunded_amount: 0 },
    ])
    db.sqlite.exec("DROP TRIGGER fail_debit")
    await StripeAccounting.refund("evt_partial", input, db.transaction)
    expect(allocations()).toEqual([
      { invoice_id: "in_a", refunded_amount: centsToMicroCents(100) },
      { invoice_id: "in_b", refunded_amount: centsToMicroCents(50) },
    ])
    await StripeAccounting.refund("evt_distinct_replay", input, db.transaction)
    await StripeAccounting.refund("evt_old", { ...input, refundedCents: 40, timeRefunded: new Date(0) }, db.transaction)
    expect(db.state().balance).toEqual({ balance: centsToMicroCents(50) })
    // A late invoice sorts first, but must not move prior durable allocations.
    await StripeAccounting.payment("evt_0", { ...payment, invoiceID: "in_0" }, {}, db.transaction)
    await StripeAccounting.refund("evt_replay_after_late", input, db.transaction)
    expect(db.state().balance).toEqual({ balance: centsToMicroCents(150) })
    await StripeAccounting.refund("evt_full", { ...input, refundedCents: 350 }, db.transaction)
    expect(db.state().balance).toEqual({ balance: 0 })
    expect(allocations()).toEqual(
      ["in_0", "in_a", "in_b"].map((invoice_id) => ({ invoice_id, refunded_amount: centsToMicroCents(100) })),
    )
  })

  test("same-event shared-intent refund replay preserves every invoice allocation", async () => {
    const db = await fixture()
    await StripeAccounting.payment("evt_a", { ...payment, invoiceID: "in_a" }, {}, db.transaction)
    await StripeAccounting.payment("evt_b", { ...payment, invoiceID: "in_b" }, {}, db.transaction)
    const input = {
      workspaceID: payment.workspaceID,
      paymentID: payment.paymentID,
      timeRefunded: new Date(0),
      refundedCents: 150,
      chargedCents: 200,
    }
    expect(await StripeAccounting.refund("evt_shared", input, db.transaction)).toBe("processed")
    const allocations = db.sqlite.query("SELECT invoice_id, refunded_amount FROM payment ORDER BY invoice_id").all()
    expect(allocations).toEqual([
      { invoice_id: "in_a", refunded_amount: centsToMicroCents(100) },
      { invoice_id: "in_b", refunded_amount: centsToMicroCents(50) },
    ])
    const committed = db.state()
    expect(await StripeAccounting.refund("evt_shared", input, db.transaction)).toBe("duplicate")
    expect(db.state()).toEqual(committed)
    expect(db.sqlite.query("SELECT invoice_id, refunded_amount FROM payment ORDER BY invoice_id").all()).toEqual(allocations)
    expect(db.state().balance).toEqual({ balance: centsToMicroCents(50) })
  })

  test("duplicate invoice history fails closed but mixed top-up/subscription distinct invoices allocate", async () => {
    const db = await fixture()
    await StripeAccounting.payment("evt_a", { ...payment, invoiceID: "in_a" }, {}, db.transaction)
    await StripeAccounting.payment(
      "evt_b",
      { ...payment, invoiceID: "in_b", enrichment: { type: "lite" } },
      undefined,
      db.transaction,
    )
    const input = {
      workspaceID: payment.workspaceID,
      paymentID: payment.paymentID,
      timeRefunded: new Date(0),
      refundedCents: 150,
      chargedCents: 200,
    }
    await StripeAccounting.refund("evt_partial", input, db.transaction)
    expect(db.state().balance).toEqual({ balance: 0 })
    db.sqlite.exec("UPDATE payment SET invoice_id = 'in_a'")
    await expect(
      StripeAccounting.refund("evt_corrupt", { ...input, refundedCents: 200 }, db.transaction),
    ).rejects.toThrow("duplicate invoice")
    expect(db.state().events).not.toContainEqual({ event_id: "evt_corrupt" })
  })

  test("stale pre-ledger canceled subscription creation cannot restore cleared membership", async () => {
    const db = await fixture()
    const apply = mock(async () => {
      throw new Error("Must not recreate canceled membership")
    })
    const retrieve = mock(async () => ({ id: "sub_old", status: "canceled" }))
    await StripeAccounting.subscription("evt_stale", "sub_old", retrieve, apply, db.transaction)
    await StripeAccounting.subscription("evt_stale_distinct", "sub_old", retrieve, apply, db.transaction)
    expect(apply).not.toHaveBeenCalled()
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(db.sqlite.query("SELECT lite_subscription_id FROM billing").get()).toEqual({ lite_subscription_id: null })
    expect(db.sqlite.query("SELECT operation_id FROM stripe_operation").all()).toEqual([
      { operation_id: "subscription:sub_old" },
    ])
  })

  test("subscription state lookup failure rolls back claims and retries active creation once", async () => {
    const db = await fixture()
    const apply = mock(async () => {})
    await expect(
      StripeAccounting.subscription(
        "evt_sub",
        "sub_live",
        async () => {
          throw new Error("offline")
        },
        apply,
        db.transaction,
      ),
    ).rejects.toThrow("offline")
    expect(db.state().events).toHaveLength(0)
    await StripeAccounting.subscription(
      "evt_sub",
      "sub_live",
      async () => ({ id: "sub_live", status: "active" }),
      apply,
      db.transaction,
    )
    await StripeAccounting.subscription(
      "evt_sub_new",
      "sub_live",
      async () => ({ id: "sub_live", status: "active" }),
      apply,
      db.transaction,
    )
    expect(apply).toHaveBeenCalledTimes(1)
  })

  test("invalid refund amounts are rejected", () => {
    expect(() => StripeAccounting.refundedCredit(100, 101, 100)).toThrow("Invalid refund amount")
    expect(() => StripeAccounting.refundedCredit(100, -1, 100)).toThrow("Invalid refund amount")
    expect(() => StripeAccounting.refundedCredit(100, 0, 0)).toThrow("Invalid refund amount")
    expect(StripeAccounting.refundedCredit(100, 100, 100)).toBe(100)
    // Partial refund of a 50-cent credit from a 100-cent charge: the fee
    // portion of the refund cannot debit extra balance.
    expect(StripeAccounting.refundedCredit(centsToMicroCents(100), 50, 100)).toBe(centsToMicroCents(50))
    expect(() => StripeAccounting.refundedCredit(centsToMicroCents(100), 150, 100)).toThrow("Invalid refund amount")
  })
})

describe("Billing production logic", () => {
  test("coupon redemption is atomic and single-use", async () => {
    const db = await fixture()
    const redeem = () =>
      Actor.provide("system", { workspaceID: "wrk_test" }, () =>
        Billing.redeemCoupon("user@test.dev", "GO1MONTH50", db.transaction),
      )
    await redeem()
    expect(db.state().coupons).toEqual([
      { email: "user@test.dev", type: "GO1MONTH50", time_redeemed: expect.any(String) },
    ])
    await expect(redeem()).rejects.toThrow("Coupon already redeemed")
    const after = db.state().coupons
    expect(after).toHaveLength(1)
    await redeem().catch(() => undefined)
    expect(db.state().coupons).toEqual(after)
  })

  test("receipt lookup requires workspace-owned payment", async () => {
    const db = await fixture()
    const use = db.transaction.bind(db)
    await Actor.provide("system", { workspaceID: "wrk_other" }, async () => {
      await expect(Billing.receiptUrl({ paymentID: "pi_test" }, use)).rejects.toThrow("Payment not found")
    })
    await StripeAccounting.payment("evt_payment", payment, {}, db.transaction)
    const client = {
      paymentIntents: {
        retrieve: async () => {
          throw new Error("network")
        },
      },
      charges: { retrieve: async () => ({ receipt_url: "https://pay.stripe.com/receipts/test" }) },
    } as never
    await Actor.provide("system", { workspaceID: "wrk_test" }, async () => {
      await expect(Billing.receiptUrl({ paymentID: "pi_test" }, use, client)).rejects.toThrow("network")
    })
    const working = {
      paymentIntents: { retrieve: async () => ({ latest_charge: "ch_1" }) },
      charges: { retrieve: async () => ({ receipt_url: "https://pay.stripe.com/receipts/test" }) },
    } as never
    await Actor.provide("system", { workspaceID: "wrk_test" }, async () => {
      expect(await Billing.receiptUrl({ paymentID: "pi_test" }, use, working)).toBe(
        "https://pay.stripe.com/receipts/test",
      )
    })
  })
  test("invoice failure diagnostics resolve the payment intent or degrade gracefully", async () => {
    const invoice = {
      payments: { data: [{ payment: { payment_intent: "pi_failed" } }] },
    } as unknown as Stripe.Invoice
    const intent = { last_payment_error: { message: "card declined" } } as unknown as Stripe.PaymentIntent
    const client = {
      invoices: { retrieve: async () => invoice },
      paymentIntents: { retrieve: async () => intent },
    } as unknown as ReturnType<typeof Billing.stripe>
    expect(await Billing.invoicePaymentError("in_failed", client)).toBe("card declined")

    const expanded = {
      payments: { data: [{ payment: { payment_intent: { last_payment_error: { message: "expired card" } } } }] },
    } as unknown as Stripe.Invoice
    const expandedClient = {
      invoices: { retrieve: async () => expanded },
      paymentIntents: { retrieve: async () => intent },
    } as unknown as ReturnType<typeof Billing.stripe>
    expect(await Billing.invoicePaymentError("in_failed", expandedClient)).toBe("expired card")

    const brokenClient = {
      invoices: {
        retrieve: async () => {
          throw new Error("boom")
        },
      },
      paymentIntents: { retrieve: async () => intent },
    } as unknown as ReturnType<typeof Billing.stripe>
    expect(await Billing.invoicePaymentError("in_failed", brokenClient)).toBeUndefined()
  })
})
