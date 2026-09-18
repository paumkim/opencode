// Payment amounts and refundedAmount are credited microcents, not Stripe's
// gross charge cents. Legacy timeRefunded with NULL amount meant full reversal.
export function paymentRefund(payment: {
  amount: number
  refundedAmount?: number | null
  timeRefunded?: Date | string | null
}) {
  const amount = Math.max(
    0,
    Math.min(payment.amount, payment.refundedAmount ?? (payment.timeRefunded ? payment.amount : 0)),
  )
  return {
    amount,
    status: amount <= 0 ? "none" : amount >= payment.amount ? "full" : "partial",
  } as const
}

export function paymentMoney(amount: number, currency?: string) {
  return new Intl.NumberFormat(currency === "inr" ? "en-IN" : "en-US", {
    style: "currency",
    currency: currency === "inr" ? "INR" : "USD",
  }).format(amount / 100_000_000)
}
