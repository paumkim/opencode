import { and, eq, sql } from "drizzle-orm"
import type { Database } from "./drizzle"
import { Identifier } from "./identifier"
import { BillingTable, LiteTable, SubscriptionTable, UsageTable } from "./schema/billing.sql"
import { UserTable } from "./schema/user.sql"
import { getMonthlyBounds, getWeekBounds } from "./util/date"

export namespace Usage {
  export interface Input {
    source: "subscription" | "lite" | "balance" | "free" | "byok"
    workspaceID: string
    userID: string
    keyID: string
    sessionID: string
    model: string
    provider: string
    usage: {
      inputTokens: number
      outputTokens: number
      reasoningTokens?: number
      cacheReadTokens?: number
      cacheWrite5mTokens?: number
      cacheWrite1hTokens?: number
    }
    cost: number
    trackedAt: Date
    costMultiplier?: number
    subscription?: { plan: string; rollingWindowSeconds: number }
    lite?: { rollingWindowSeconds: number; quotaCost: number; timeCreated: Date }
  }

  // One transactional accounting unit per request: the usage ledger row and every
  // total it implies commit or roll back together. No Redis, no batching, no
  // post-commit acknowledgement that can strand chargeable usage.
  export function record(tx: Database.TxOrDb, input: Input) {
    const { cost, trackedAt } = input
    const paid = input.source === "balance" ? cost : 0
    return Promise.all([
      tx.insert(UsageTable).values({
        workspaceID: input.workspaceID,
        id: Identifier.create("usage"),
        model: input.model,
        provider: input.provider,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        reasoningTokens: input.usage.reasoningTokens,
        cacheReadTokens: input.usage.cacheReadTokens,
        cacheWrite5mTokens: input.usage.cacheWrite5mTokens,
        cacheWrite1hTokens: input.usage.cacheWrite1hTokens,
        cost,
        keyID: input.keyID,
        sessionID: input.sessionID.substring(0, 30),
        enrichment: (() => {
          if (input.source === "subscription") return { plan: "sub" }
          if (input.source === "byok") return { plan: "byok" }
          if (input.source === "lite") return { plan: "lite", costMultiplier: input.costMultiplier }
          return undefined
        })(),
      }),
      ...(() => {
        if (input.source === "subscription") {
          const week = getWeekBounds(trackedAt)
          const rollingWindowSeconds = input.subscription!.rollingWindowSeconds
          return [
            tx
              .update(SubscriptionTable)
              .set({
                fixedUsage: sql`
              CASE
                WHEN ${SubscriptionTable.timeFixedUpdated} >= ${week.end} THEN ${SubscriptionTable.fixedUsage}
                WHEN ${SubscriptionTable.timeFixedUpdated} >= ${week.start} THEN ${SubscriptionTable.fixedUsage} + ${cost}
                ELSE ${cost}
              END
            `,
                timeFixedUpdated: sql`
              CASE
                WHEN ${SubscriptionTable.timeFixedUpdated} > ${trackedAt} THEN ${SubscriptionTable.timeFixedUpdated}
                ELSE ${trackedAt}
              END
            `,
                rollingUsage: sql`
              CASE
                WHEN UNIX_TIMESTAMP(${SubscriptionTable.timeRollingUpdated}) >= UNIX_TIMESTAMP(now()) - ${rollingWindowSeconds} THEN ${SubscriptionTable.rollingUsage} + ${cost}
                ELSE ${cost}
              END
            `,
                timeRollingUpdated: sql`
              CASE
                WHEN UNIX_TIMESTAMP(${SubscriptionTable.timeRollingUpdated}) >= UNIX_TIMESTAMP(now()) - ${rollingWindowSeconds} THEN ${SubscriptionTable.timeRollingUpdated}
                ELSE now()
              END
            `,
              })
              .where(
                and(eq(SubscriptionTable.workspaceID, input.workspaceID), eq(SubscriptionTable.userID, input.userID)),
              ),
          ]
        }
        if (input.source === "lite") {
          const week = getWeekBounds(trackedAt)
          const month = getMonthlyBounds(trackedAt, input.lite!.timeCreated)
          const rollingWindowSeconds = input.lite!.rollingWindowSeconds
          const quotaCost = input.lite!.quotaCost
          return [
            tx
              .update(LiteTable)
              .set({
                monthlyUsage: sql`
              CASE
                WHEN ${LiteTable.timeMonthlyUpdated} >= ${month.end} THEN ${LiteTable.monthlyUsage}
                WHEN ${LiteTable.timeMonthlyUpdated} >= ${month.start} THEN ${LiteTable.monthlyUsage} + ${quotaCost}
                ELSE ${quotaCost}
              END
            `,
                timeMonthlyUpdated: sql`
              CASE
                WHEN ${LiteTable.timeMonthlyUpdated} > ${trackedAt} THEN ${LiteTable.timeMonthlyUpdated}
                ELSE ${trackedAt}
              END
            `,
                weeklyUsage: sql`
              CASE
                WHEN ${LiteTable.timeWeeklyUpdated} >= ${week.end} THEN ${LiteTable.weeklyUsage}
                WHEN ${LiteTable.timeWeeklyUpdated} >= ${week.start} THEN ${LiteTable.weeklyUsage} + ${quotaCost}
                ELSE ${quotaCost}
              END
            `,
                timeWeeklyUpdated: sql`
              CASE
                WHEN ${LiteTable.timeWeeklyUpdated} > ${trackedAt} THEN ${LiteTable.timeWeeklyUpdated}
                ELSE ${trackedAt}
              END
            `,
                rollingUsage: sql`
              CASE
                WHEN UNIX_TIMESTAMP(${LiteTable.timeRollingUpdated}) >= UNIX_TIMESTAMP(now()) - ${rollingWindowSeconds} THEN ${LiteTable.rollingUsage} + ${quotaCost}
                ELSE ${quotaCost}
              END
            `,
                timeRollingUpdated: sql`
              CASE
                WHEN UNIX_TIMESTAMP(${LiteTable.timeRollingUpdated}) >= UNIX_TIMESTAMP(now()) - ${rollingWindowSeconds} THEN ${LiteTable.timeRollingUpdated}
                ELSE now()
              END
            `,
              })
              .where(and(eq(LiteTable.workspaceID, input.workspaceID), eq(LiteTable.userID, input.userID))),
          ]
        }

        return [
          tx
            .update(BillingTable)
            .set({
              balance: sql`${BillingTable.balance} - ${paid}`,
              monthlyUsage: sql`
              CASE
                WHEN MONTH(${BillingTable.timeMonthlyUsageUpdated}) = MONTH(now()) AND YEAR(${BillingTable.timeMonthlyUsageUpdated}) = YEAR(now()) THEN ${BillingTable.monthlyUsage} + ${cost}
                ELSE ${cost}
              END
            `,
              timeMonthlyUsageUpdated: sql`now()`,
            })
            .where(eq(BillingTable.workspaceID, input.workspaceID)),
          tx
            .update(UserTable)
            .set({
              monthlyUsage: sql`
              CASE
                WHEN MONTH(${UserTable.timeMonthlyUsageUpdated}) = MONTH(now()) AND YEAR(${UserTable.timeMonthlyUsageUpdated}) = YEAR(now()) THEN ${UserTable.monthlyUsage} + ${cost}
                ELSE ${cost}
              END
            `,
              timeMonthlyUsageUpdated: sql`now()`,
            })
            .where(and(eq(UserTable.workspaceID, input.workspaceID), eq(UserTable.id, input.userID))),
        ]
      })(),
    ])
  }
}
