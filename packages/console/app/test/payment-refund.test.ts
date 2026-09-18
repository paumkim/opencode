import { describe, expect, test } from "bun:test"
import { paymentMoney, paymentRefund } from "../src/routes/workspace/[id]/billing/payment-refund"

const amount = 2_000_000_000 // $20 in microcents

describe("payment refund presentation used by PaymentSection", () => {
  test("partial refund keeps original amount visible and shows credited refund units", () => {
    const refund = paymentRefund({ amount, refundedAmount: 500_000_000, timeRefunded: new Date(0) })
    expect(refund).toEqual({ amount: 500_000_000, status: "partial" })
    expect(paymentMoney(refund.amount)).toBe("$5.00")
    expect(paymentMoney(amount)).toBe("$20.00")
  })
  test("full refund is struck, legacy NULL timestamp rows remain full", () => {
    expect(paymentRefund({ amount, refundedAmount: amount }).status).toBe("full")
    expect(paymentRefund({ amount, refundedAmount: null, timeRefunded: "2026-01-01" })).toEqual({
      amount,
      status: "full",
    })
    expect(paymentRefund({ amount, timeRefunded: new Date(0) }).status).toBe("full")
  })
  test("zero/refundless/zero-cost rows are not marked fully refunded", () => {
    expect(paymentRefund({ amount, refundedAmount: 0, timeRefunded: new Date(0) }).status).toBe("none")
    expect(paymentRefund({ amount, refundedAmount: null }).status).toBe("none")
    expect(paymentRefund({ amount: 0, timeRefunded: new Date(0) }).status).toBe("none")
  })
  test("INR refunds preserve currency and display caps corrupt over-refunds", () => {
    expect(paymentMoney(500_000_000, "inr")).toBe("₹5.00")
    expect(paymentRefund({ amount, refundedAmount: amount + 1 })).toEqual({ amount, status: "full" })
  })
})
