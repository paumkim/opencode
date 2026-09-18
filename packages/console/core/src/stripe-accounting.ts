import { randomUUID } from "node:crypto"
import { and, Database, eq, isNull, or, sql } from "./drizzle"
import { BillingTable, PaymentTable, StripeEventTable, StripeOperationTable } from "./schema/billing.sql"
import { centsToMicroCents } from "./util/price"
import { Identifier } from "./identifier"

export namespace StripeAccounting {
  // The upsert takes the unique-key lock even for a duplicate. A concurrent
  // delivery waits for commit/rollback before checking who owns the claim.
  // Do not use affected-row counts: CLIENT_FOUND_ROWS changes their meaning.
  export async function run(
    eventID: string,
    apply: (tx: Database.TxOrDb) => Promise<unknown>,
    transaction = Database.transaction,
  ) {
    return transaction(async (tx) => {
      const claim = randomUUID()
      await tx
        .insert(StripeEventTable)
        .values({ event_id: eventID, claim_id: claim })
        .onDuplicateKeyUpdate({ set: { event_id: sql`${StripeEventTable.event_id}` } })
      const rows = await tx
        .select({ claim: StripeEventTable.claim_id })
        .from(StripeEventTable)
        .where(eq(StripeEventTable.event_id, eventID))
        .for("update")
      if (rows[0]?.claim !== claim) return "duplicate"
      // The claim is only durable if every accounting write commits with it.
      await apply(tx)
      return "processed"
    })
  }

  export async function operation(tx: Database.TxOrDb, operationID: string, apply: () => Promise<unknown>) {
    const claim = randomUUID()
    await tx
      .insert(StripeOperationTable)
      .values({ operation_id: operationID, claim_id: claim })
      .onDuplicateKeyUpdate({ set: { operation_id: sql`${StripeOperationTable.operation_id}` } })
    const rows = await tx
      .select({ claim: StripeOperationTable.claim_id })
      .from(StripeOperationTable)
      .where(eq(StripeOperationTable.operation_id, operationID))
      .for("update")
    if (rows[0]?.claim !== claim) return "duplicate"
    await apply()
    return "processed"
  }

  export async function subscription(
    eventID: string,
    subscriptionID: string,
    retrieve: () => Promise<{ id: string; status: string }>,
    apply: (tx: Database.TxOrDb) => Promise<unknown>,
    transaction = Database.transaction,
  ) {
    return run(
      eventID,
      (tx) =>
        operation(tx, `subscription:${subscriptionID}`, async () => {
          // Current workspace state alone is not history: cancellation clears it.
          // Stripe terminal states cannot be reactivated. Persist this operation
          // even when ignored so stale pre-ledger creation cannot restore access.
          // Retrieval errors roll back both claims for retry, never imply active.
          const current = await retrieve()
          if (current.id !== subscriptionID) throw new Error("Subscription ID mismatch")
          if (current.status === "canceled" || current.status === "incomplete_expired") return
          await apply(tx)
        }),
      transaction,
    )
  }

  // Serialize aliases (invoice vs payment intent) and legacy-history checks on
  // the workspace billing row. All balance mutations use arithmetic SQL updates.
  async function lockBilling(tx: Database.TxOrDb, workspaceID: string) {
    const rows = await tx
      .select({ id: BillingTable.id })
      .from(BillingTable)
      .where(eq(BillingTable.workspaceID, workspaceID))
      .for("update")
    if (rows.length !== 1) throw new Error("Expected one workspace billing record")
  }

  export async function payment(
    eventID: string,
    payment: Omit<typeof PaymentTable.$inferInsert, "id">,
    billing?: Partial<Omit<typeof BillingTable.$inferInsert, "id" | "workspaceID" | "balance">>,
    transaction = Database.transaction,
  ) {
    return run(
      eventID,
      async (tx) => {
        if (!payment.invoiceID && !payment.paymentID) throw new Error("Payment or invoice ID required")
        if (!Number.isSafeInteger(payment.amount) || payment.amount < 0) throw new Error("Invalid payment amount")
        await lockBilling(tx, payment.workspaceID)
        await operation(
          tx,
          payment.invoiceID ? `invoice:${payment.invoiceID}` : `payment:${payment.paymentID}`,
          async () => {
            // No unique index on historical payments: duplicates may already exist.
            // Locking reads see the latest commit even at REPEATABLE READ. An intent
            // can fund separate invoices; only match that alias when an invoice is absent.
            const existing = await tx
              .select({ id: PaymentTable.id })
              .from(PaymentTable)
              .where(
                and(
                  eq(PaymentTable.workspaceID, payment.workspaceID),
                  or(
                    payment.invoiceID ? eq(PaymentTable.invoiceID, payment.invoiceID) : undefined,
                    // An intent can fund separate invoices; only pair the intent
                    // alias with an invoice-less row when the event has an invoice.
                    // An invoice-less event is the same money as any row holding
                    // the same intent.
                    payment.paymentID
                      ? payment.invoiceID
                        ? and(eq(PaymentTable.paymentID, payment.paymentID), isNull(PaymentTable.invoiceID))
                        : eq(PaymentTable.paymentID, payment.paymentID)
                      : undefined,
                  ),
                ),
              )
              .for("update")
            if (existing.length) return
            if (billing) {
              await tx
                .update(BillingTable)
                .set({ ...billing, balance: sql`${BillingTable.balance} + ${payment.amount}` })
                .where(eq(BillingTable.workspaceID, payment.workspaceID))
            }
            await tx.insert(PaymentTable).values({ ...payment, refundedAmount: 0, id: Identifier.create("payment") })
          },
        )
      },
      transaction,
    )
  }

  export function refundedCredit(credit: number, refundedCents: number, chargedCents: number) {
    if (
      !Number.isSafeInteger(credit) ||
      credit < 0 ||
      !Number.isSafeInteger(refundedCents) ||
      refundedCents < 0 ||
      !Number.isSafeInteger(chargedCents) ||
      chargedCents <= 0 ||
      refundedCents > chargedCents ||
      !Number.isSafeInteger(centsToMicroCents(refundedCents))
    )
      throw new Error("Invalid refund amount")
    // Credit-first policy: fees were charged separately and never credited.
    // Reverse refunded cents 1:1 up to the original credit; refunding the fee
    // portion cannot debit extra balance. Full refunds still reverse all credit.
    // A zero cumulative refund is a no-op, not a fee refund. Stripe does not
    // identify fee-only refunds here; credit-first remains the explicit policy.
    if (refundedCents === 0) return 0
    return refundedCents === chargedCents ? credit : Math.min(credit, centsToMicroCents(refundedCents))
  }

  export async function refund(
    eventID: string,
    input: { workspaceID: string; paymentID: string; timeRefunded: Date; refundedCents: number; chargedCents: number },
    transaction = Database.transaction,
  ) {
    return run(
      eventID,
      async (tx) => {
        await lockBilling(tx, input.workspaceID)
        const payments = await tx
          .select()
          .from(PaymentTable)
          .where(and(eq(PaymentTable.paymentID, input.paymentID), eq(PaymentTable.workspaceID, input.workspaceID)))
          .for("update")
        if (!payments.length) throw new Error("Payment not found")
        // Shared intents are legitimate only with distinct, non-null invoices
        // and consistent customer/currency. Missing/repeated aliases are corrupt
        // history, not additional credits to silently reverse.
        if (
          payments.length > 1 &&
          (payments.some((row) => !row.invoiceID) ||
            new Set(payments.map((row) => row.invoiceID)).size !== payments.length ||
            new Set(payments.map((row) => row.customerID)).size !== 1 ||
            new Set(
              payments.map((row) =>
                row.enrichment && "currency" in row.enrichment ? (row.enrichment.currency ?? "usd") : "usd",
              ),
            ).size !== 1)
        )
          throw new Error(
            `Ambiguous payment refund ${input.paymentID}: reconcile missing/duplicate invoice or customer/currency history`,
          )

        const previous = payments.map((row) => row.refundedAmount ?? (row.timeRefunded ? row.amount : 0))
        if (
          payments.some(
            (row, index) =>
              !Number.isSafeInteger(row.amount) ||
              row.amount < 0 ||
              !Number.isSafeInteger(previous[index]) ||
              previous[index] < 0 ||
              previous[index] > row.amount,
          )
        ) {
          throw new Error(`Invalid refund history for ${input.paymentID}; reconciliation required`)
        }
        const cumulative = refundedCredit(
          payments.reduce((sum, row) => sum + row.amount, 0),
          input.refundedCents,
          input.chargedCents,
        )
        // Preserve durable allocations, including legacy full reversals. Allocate
        // only the unprocessed cumulative delta in binary invoice-ID order, then
        // payment-ID order. Late-arriving invoices cannot move prior allocations
        // or debit them again; all reads/writes share the billing-row lock + tx.
        let remaining = Math.max(0, cumulative - previous.reduce((sum, amount) => sum + amount, 0))
        let debit = 0
        const ordered = payments
          .map((row, index) => ({ row, previous: previous[index] }))
          .sort((a, b) => {
            const left = a.row.invoiceID ?? a.row.id
            const right = b.row.invoiceID ?? b.row.id
            return left < right ? -1 : left > right ? 1 : 0
          })
        for (const { row, previous } of ordered) {
          const delta = Math.min(remaining, row.amount - previous)
          remaining -= delta
          if (!delta) continue
          await tx
            .update(PaymentTable)
            .set({
              refundedAmount: previous + delta,
              timeRefunded:
                row.timeRefunded && row.timeRefunded > input.timeRefunded ? row.timeRefunded : input.timeRefunded,
            })
            .where(and(eq(PaymentTable.id, row.id), eq(PaymentTable.workspaceID, input.workspaceID)))
          // Subscription payments never credited the prepaid balance.
          if (!row.enrichment?.type) debit += delta
        }
        if (debit) {
          await tx
            .update(BillingTable)
            .set({ balance: sql`${BillingTable.balance} - ${debit}` })
            .where(eq(BillingTable.workspaceID, input.workspaceID))
        }
      },
      transaction,
    )
  }
}
