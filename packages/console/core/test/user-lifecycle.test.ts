import { describe, expect, test } from "bun:test"
import { drizzle } from "drizzle-orm/planetscale-serverless"
import { Client } from "@planetscale/database"
import { and, eq } from "drizzle-orm"
import { User } from "../src/user"
import { Actor } from "../src/actor"
import { KeyTable } from "../src/schema/key.sql"
import { UserTable } from "../src/schema/user.sql"
import { WorkspaceTable } from "../src/schema/workspace.sql"

// SQL/transaction transport only: no credentials, database, or network access.
function fixture(failKeys = false) {
  const queries: { query: string; values: unknown[] }[] = []
  const db = drizzle({ client: new Client({
    host: "unused.invalid",
    username: "test",
    password: "test",
    format: (query, values) => JSON.stringify({ query, values }),
    fetch: async (_url, init) => {
      const encoded: string = JSON.parse(init!.body).query
      const request = encoded.startsWith("{") ? JSON.parse(encoded) : { query: encoded, values: [] }
      queries.push(request)
      if (failKeys && request.query.startsWith("update `key`")) throw new Error("key write failed")
      return Response.json({ result: { fields: [], rows: [], rowsAffected: "1" } })
    },
  }) })
  return { db, queries, transaction: db.transaction.bind(db) }
}

const admin = { userID: "usr_admin", workspaceID: "wrk_test", accountID: "acc_test", role: "admin" as const }

describe("member key lifecycle production queries", () => {
  test("active key predicate rejects legacy keys when membership or workspace is deleted", () => {
    const { db } = fixture()
    const query = db.select({ id: KeyTable.id }).from(KeyTable)
      .innerJoin(UserTable, and(eq(UserTable.id, KeyTable.userID), eq(UserTable.workspaceID, KeyTable.workspaceID)))
      .innerJoin(WorkspaceTable, eq(WorkspaceTable.id, KeyTable.workspaceID))
      .where(User.activeKey("test-key")).toSQL()
    expect(query.sql).toContain("`key`.`time_deleted` is null")
    expect(query.sql).toContain("`user`.`time_deleted` is null")
    expect(query.sql).toContain("`workspace`.`time_deleted` is null")
    expect(query.params).toEqual(["test-key"])
  })

  test("removal revokes ALL existing member keys in the same workspace transaction", async () => {
    const f = fixture()
    await Actor.provide("user", admin, () => User.revokeMembership("usr_member", f.transaction))
    expect(f.queries.map((x) => x.query.split(" ")[0])).toEqual(["BEGIN", "update", "update", "COMMIT"])
    const key = f.queries[2]
    expect(key.query).toContain("`key`.`user_id` = ?")
    expect(key.query).toContain("`key`.`workspace_id` = ?")
    expect(key.query).not.toContain("`key`.`id` =")
    expect(key.values).toEqual(["usr_member", "wrk_test"])
  })

  test("key write failure rolls back member deletion", async () => {
    const f = fixture(true)
    await expect(Actor.provide("user", admin, () => User.revokeMembership("usr_member", f.transaction))).rejects.toThrow()
    expect(f.queries.at(-1)?.query).toBe("ROLLBACK")
    expect(f.queries.some((x) => x.query === "COMMIT")).toBe(false)
  })

  test("self-removal and non-admin removal never start a transaction", async () => {
    const f = fixture()
    await expect(Actor.provide("user", admin, () => User.revokeMembership(admin.userID, f.transaction))).rejects.toThrow()
    await expect(Actor.provide("user", { ...admin, role: "member" }, () => User.revokeMembership("usr_member", f.transaction))).rejects.toThrow()
    expect(f.queries).toEqual([])
  })

  test("reinvitation ignores revoked keys when deciding whether to issue a new default", async () => {
    // Pin the call site too: revoked historical keys must never suppress replacement.
    const source = await Bun.file(new URL("../src/user.ts", import.meta.url)).text()
    expect(source).toContain("isNull(KeyTable.timeDeleted)")
    const query = source.slice(source.indexOf("const key = await tx"), source.indexOf("if (key) return"))
    expect(query).toContain("isNull(KeyTable.timeDeleted)")
  })
})
