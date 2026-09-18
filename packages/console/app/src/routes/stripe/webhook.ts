import type { Stripe } from "stripe"
import { Billing } from "@opencode-ai/console-core/billing.js"
import type { APIEvent } from "@solidjs/start/server"
import { Database, eq, sql } from "@opencode-ai/console-core/drizzle/index.js"
import { BillingTable, LiteTable } from "@opencode-ai/console-core/schema/billing.sql.js"
import { StripeAccounting } from "@opencode-ai/console-core/stripe-accounting.js"
import { Identifier } from "@opencode-ai/console-core/identifier.js"
import { centsToMicroCents } from "@opencode-ai/console-core/util/price.js"
import { Actor } from "@opencode-ai/console-core/actor.js"
import { Resource } from "@opencode-ai/console-resource"
import { LiteData } from "@opencode-ai/console-core/lite.js"
import { BlackData } from "@opencode-ai/console-core/black.js"
import { Referral } from "@opencode-ai/console-core/referral.js"

export async function POST(input: APIEvent) {
  const body = await Billing.stripe().webhooks.constructEventAsync(
    await input.request.text(),
    input.request.headers.get("stripe-signature")!,
    Resource.STRIPE_WEBHOOK_SECRET.value,
  )
  console.log(body.type, JSON.stringify(body, null, 2))

  return (async () => {
    if (body.type === "customer.updated") {
      // check default payment method changed
      const prevInvoiceSettings = body.data.previous_attributes?.invoice_settings ?? {}
      if (!("default_payment_method" in prevInvoiceSettings)) return "ignored"

      const customerID = body.data.object.id
      const paymentMethodID = body.data.object.invoice_settings.default_payment_method as string

      if (!customerID) throw new Error("Customer ID not found")
      if (!paymentMethodID) throw new Error("Payment method ID not found")

      const paymentMethod = await Billing.stripe().paymentMethods.retrieve(paymentMethodID)
      await Database.use(async (tx) => {
        await tx
          .update(BillingTable)
          .set({
            paymentMethodID,
            paymentMethodLast4: paymentMethod.card?.last4 ?? null,
            paymentMethodType: paymentMethod.type,
          })
          .where(eq(BillingTable.customerID, customerID))
      })
    }
    if (body.type === "checkout.session.completed" && body.data.object.mode === "payment") {
      const workspaceID = body.data.object.metadata?.workspaceID
      const amountInCents = body.data.object.metadata?.amount && parseInt(body.data.object.metadata?.amount)
      const customerID = body.data.object.customer as string
      const paymentID = body.data.object.payment_intent as string
      const invoiceID = body.data.object.invoice as string

      if (!workspaceID) throw new Error("Workspace ID not found")
      if (!customerID) throw new Error("Customer ID not found")
      if (!amountInCents) throw new Error("Amount not found")
      if (!paymentID) throw new Error("Payment ID not found")
      if (!invoiceID) throw new Error("Invoice ID not found")

      await Actor.provide("system", { workspaceID }, async () => {
        const customer = await Billing.get()
        if (customer?.customerID && customer.customerID !== customerID) throw new Error("Customer ID mismatch")

        // set customer metadata
        if (!customer?.customerID) {
          await Billing.stripe().customers.update(customerID, {
            metadata: {
              workspaceID,
            },
          })
        }

        // get payment method for the payment intent
        const paymentIntent = await Billing.stripe().paymentIntents.retrieve(paymentID, {
          expand: ["payment_method"],
        })
        const paymentMethod = paymentIntent.payment_method
        if (!paymentMethod || typeof paymentMethod === "string") throw new Error("Payment method not expanded")

        await StripeAccounting.payment(
          body.id,
          {
            workspaceID,
            amount: centsToMicroCents(amountInCents),
            paymentID,
            invoiceID,
            customerID,
          },
          {
            customerID,
            paymentMethodID: paymentMethod.id,
            paymentMethodLast4: paymentMethod.card?.last4 ?? null,
            paymentMethodType: paymentMethod.type,
            // enable reload if first time enabling billing
            ...(customer?.customerID
              ? {}
              : {
                  reloadError: null,
                  timeReloadError: null,
                }),
          },
        )
      })
    }
    if (body.type === "customer.subscription.created") {
      const type = body.data.object.metadata?.type
      if (type === "lite") {
        const workspaceID = body.data.object.metadata?.workspaceID
        const userID = body.data.object.metadata?.userID
        const userEmail = body.data.object.metadata?.userEmail
        const coupon = body.data.object.metadata?.coupon
        const customerID = body.data.object.customer as string
        const invoiceID = body.data.object.latest_invoice as string
        const subscriptionID = body.data.object.id
        const paymentMethodID = body.data.object.default_payment_method as string

        if (!workspaceID) throw new Error("Workspace ID not found")
        if (!userID) throw new Error("User ID not found")
        if (!customerID) throw new Error("Customer ID not found")
        if (!invoiceID) throw new Error("Invoice ID not found")
        if (!subscriptionID) throw new Error("Subscription ID not found")
        if (!paymentMethodID) throw new Error("Payment method ID not found")

        // get payment method for the payment intent
        const paymentMethod = await Billing.stripe().paymentMethods.retrieve(paymentMethodID)
        await Actor.provide("system", { workspaceID }, async () => {
          // look up current billing
          const billing = await Billing.get()
          if (!billing) throw new Error(`Workspace with ID ${workspaceID} not found`)
          if (billing.customerID && billing.customerID !== customerID) throw new Error("Customer ID mismatch")

          // set customer metadata
          if (!billing?.customerID) {
            await Billing.stripe().customers.update(customerID, {
              metadata: {
                workspaceID,
              },
            })
          }

          await StripeAccounting.subscription(
            body.id,
            subscriptionID,
            () => Billing.stripe().subscriptions.retrieve(subscriptionID),
            async (tx) => {
              // Existing subscriptions predate the operation ledger. Lock and check
              // before inserting membership or redeeming a coupon again.
              const current = await tx
                .select({ subscriptionID: BillingTable.liteSubscriptionID })
                .from(BillingTable)
                .where(eq(BillingTable.workspaceID, workspaceID))
                .for("update")
                .then((rows) => rows[0])
              if (!current) throw new Error("Billing record not found")
              if (current.subscriptionID === subscriptionID) return
              if (current.subscriptionID) throw new Error("Workspace already has a Lite subscription")
              await tx
                .update(BillingTable)
                .set({
                  customerID,
                  liteSubscriptionID: subscriptionID,
                  lite: {},
                  paymentMethodID: paymentMethod.id,
                  paymentMethodLast4: paymentMethod.card?.last4 ?? null,
                  paymentMethodType: paymentMethod.type,
                })
                .where(eq(BillingTable.workspaceID, workspaceID))

              await tx.insert(LiteTable).values({
                workspaceID,
                id: Identifier.create("lite"),
                userID: userID,
              })

              if (userEmail) {
                if (coupon === LiteData.firstMonth50Coupon) {
                  await Billing.redeemCoupon(userEmail, "GO1MONTH50", (apply) => apply(tx))
                } else if (coupon === LiteData.firstMonth100Coupon) {
                  await Billing.redeemCoupon(userEmail, "GOFREEMONTH", (apply) => apply(tx))
                } else if (coupon === LiteData.threeMonths100Coupon) {
                  await Billing.redeemCoupon(userEmail, "GO3MONTHS100", (apply) => apply(tx))
                } else if (coupon === LiteData.sixMonths100Coupon) {
                  await Billing.redeemCoupon(userEmail, "GO6MONTHS100", (apply) => apply(tx))
                } else if (coupon === LiteData.twelveMonths100Coupon) {
                  await Billing.redeemCoupon(userEmail, "GO12MONTHS100", (apply) => apply(tx))
                }
              }
            },
          )

          await Referral.completeFromLiteSubscription({
            workspaceID,
            userID,
          }).catch((error) => {
            console.error("Referral sync failed", error)
          })
        })
      }
    }
    if (body.type === "customer.subscription.updated" && body.data.object.status === "incomplete_expired") {
      const subscriptionID = body.data.object.id
      if (!subscriptionID) throw new Error("Subscription ID not found")

      const productID = body.data.object.items.data[0].price.product as string
      if (productID === LiteData.productID()) {
        await Billing.unsubscribeLite({ subscriptionID })
      } else if (productID === BlackData.productID()) {
        await Billing.unsubscribeBlack({ subscriptionID })
      }
    }
    if (body.type === "customer.subscription.deleted") {
      const subscriptionID = body.data.object.id
      if (!subscriptionID) throw new Error("Subscription ID not found")

      const productID = body.data.object.items.data[0].price.product as string
      if (productID === LiteData.productID()) {
        await Billing.unsubscribeLite({ subscriptionID })
      } else if (productID === BlackData.productID()) {
        await Billing.unsubscribeBlack({ subscriptionID })
      }

      const latestInvoice = body.data.object.latest_invoice
      const invoiceID = typeof latestInvoice === "string" ? latestInvoice : latestInvoice?.id
      if (invoiceID) {
        const invoice = await Billing.stripe().invoices.retrieve(invoiceID)
        if (invoice.status === "open") await Billing.stripe().invoices.voidInvoice(invoiceID)
      }
    }
    if (body.type === "invoice.payment_succeeded") {
      if (
        body.data.object.billing_reason === "subscription_create" ||
        body.data.object.billing_reason === "subscription_cycle"
      ) {
        const invoiceID = body.data.object.id as string
        const amountInCents = body.data.object.amount_paid
        const customerID = body.data.object.customer as string
        const subscriptionID = body.data.object.parent?.subscription_details?.subscription as string
        const productID = body.data.object.lines?.data[0].pricing?.price_details?.product as string

        if (!customerID) throw new Error("Customer ID not found")
        if (!invoiceID) throw new Error("Invoice ID not found")
        if (!subscriptionID) throw new Error("Subscription ID not found")

        // get coupon id from subscription
        const invoice = await Billing.stripe().invoices.retrieve(invoiceID, {
          expand: ["discounts", "payments"],
        })
        const paymentID = invoice.payments?.data[0]?.payment.payment_intent as string
        const couponID = (invoice.discounts[0] as Stripe.Discount)?.coupon?.id
        if (!paymentID) {
          // payment id can be undefined when using coupon
          if (!couponID) throw new Error("Payment ID not found")
        }

        const workspaceID = await Database.use((tx) =>
          tx
            .select({ workspaceID: BillingTable.workspaceID })
            .from(BillingTable)
            .where(eq(BillingTable.customerID, customerID))
            .then((rows) => rows[0]?.workspaceID),
        )
        if (!workspaceID) throw new Error("Workspace ID not found for customer")

        await StripeAccounting.payment(body.id, {
          workspaceID,
          amount: centsToMicroCents(amountInCents),
          paymentID,
          invoiceID,
          customerID,
          enrichment: {
            type: productID === LiteData.productID() ? "lite" : "subscription",
            currency: body.data.object.currency === "inr" ? "inr" : undefined,
            couponID,
          },
        })
      } else if (body.data.object.billing_reason === "manual") {
        const workspaceID = body.data.object.metadata?.workspaceID
        const amountInCents = body.data.object.metadata?.amount && parseInt(body.data.object.metadata?.amount)
        const invoiceID = body.data.object.id as string
        const customerID = body.data.object.customer as string

        if (!workspaceID) throw new Error("Workspace ID not found")
        if (!customerID) throw new Error("Customer ID not found")
        if (!amountInCents) throw new Error("Amount not found")
        if (!invoiceID) throw new Error("Invoice ID not found")

        await Actor.provide("system", { workspaceID }, async () => {
          // get payment id from invoice
          const invoice = await Billing.stripe().invoices.retrieve(invoiceID, {
            expand: ["payments"],
          })
          await StripeAccounting.payment(
            body.id,
            {
              workspaceID: Actor.workspace(),
              amount: centsToMicroCents(amountInCents),
              invoiceID,
              paymentID: invoice.payments?.data[0].payment.payment_intent as string,
              customerID,
            },
            { reloadError: null, timeReloadError: null },
          )
        })
      }
    }
    if (body.type === "invoice.payment_failed" || body.type === "invoice.payment_action_required") {
      if (body.data.object.billing_reason === "manual") {
        const workspaceID = body.data.object.metadata?.workspaceID
        const invoiceID = body.data.object.id

        if (!workspaceID) throw new Error("Workspace ID not found")
        if (!invoiceID) throw new Error("Invoice ID not found")

        const errorMessage = await Billing.invoicePaymentError(invoiceID)

        await Actor.provide("system", { workspaceID }, async () => {
          await Database.use((tx) =>
            tx
              .update(BillingTable)
              .set({
                reload: false,
                reloadError: errorMessage ?? "workspace.reload.error.paymentFailed",
                timeReloadError: sql`now()`,
              })
              .where(eq(BillingTable.workspaceID, Actor.workspace())),
          )
        })
      }
    }
    if (body.type === "charge.refunded") {
      const customerID = body.data.object.customer as string
      const paymentIntentID = body.data.object.payment_intent as string
      if (!customerID) throw new Error("Customer ID not found")
      if (!paymentIntentID) throw new Error("Payment ID not found")

      const workspaceID = await Database.use((tx) =>
        tx
          .select({
            workspaceID: BillingTable.workspaceID,
          })
          .from(BillingTable)
          .where(eq(BillingTable.customerID, customerID))
          .then((rows) => rows[0]?.workspaceID),
      )
      if (!workspaceID) throw new Error("Workspace ID not found")

      await StripeAccounting.refund(body.id, {
        workspaceID,
        paymentID: paymentIntentID,
        timeRefunded: new Date(body.created * 1000),
        refundedCents: body.data.object.amount_refunded,
        chargedCents: body.data.object.amount,
      })
    }
  })()
    .then((message) => {
      return Response.json({ message: message ?? "done" }, { status: 200 })
    })
    .catch((error: any) => {
      return Response.json({ message: error.message }, { status: 500 })
    })
}
