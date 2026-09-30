import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { PermissionExplain } from "../../src/permission/explain"

const rule = (permission: string, action: PermissionV1.Action, pattern = "*"): PermissionV1.Rule => ({
  permission,
  action,
  pattern,
})

describe("permissionExplain.matched", () => {
  test("names the rule that asked, and where it sits", () => {
    const [only] = PermissionExplain.matched("bash", "rm -rf", [rule("bash", "ask"), rule("edit", "allow")])
    expect(only).toEqual({
      pattern: "rm -rf",
      rule: rule("bash", "ask"),
      // Index 0 of 2: the second rule in the file, of two considered.
      index: 0,
      total: 2,
    })
  })

  test("points at the rule that won, not the first that matched", () => {
    const [only] = PermissionExplain.matched("bash", "ls", [
      rule("bash", "deny"),
      rule("bash", "allow", "l*"),
      rule("bash", "ask", "ls"),
    ])
    expect(only.rule).toEqual(rule("bash", "ask", "ls"))
    expect(only.index).toBe(2)
    expect(only.total).toBe(3)
  })

  test("counts every rule consulted, including ones that do not match", () => {
    // The total is what makes "rule 64 of 87" mean something, and a total that
    // only counted the matches would quietly disagree with `permission explain`.
    const [only] = PermissionExplain.matched("bash", "ls", [rule("edit", "deny"), rule("bash", "ask", "ls*")])
    expect(only.total).toBe(2)
  })

  test("counts across every ruleset, in order", () => {
    const [only] = PermissionExplain.matched(
      "bash",
      "ls",
      [rule("bash", "deny")],
      [rule("edit", "allow")],
      [rule("bash", "ask", "ls*")],
    )
    expect(only.index).toBe(2)
    expect(only.total).toBe(3)
  })

  test("reports the default when no rule matched, because that is the reason", () => {
    const [only] = PermissionExplain.matched("bash", "ls", [rule("edit", "allow")])
    expect(only).toEqual({ pattern: "ls", rule: rule("bash", "ask"), index: -1, total: 1 })
    expect(PermissionExplain.isDefault(only)).toBe(true)
  })

  test("an empty ruleset is still a reason: nothing covers it", () => {
    const [only] = PermissionExplain.matched("bash", "ls")
    expect(only).toEqual({ pattern: "ls", rule: rule("bash", "ask"), index: -1, total: 0 })
  })

  test("a rule that asked is not a default", () => {
    const [only] = PermissionExplain.matched("bash", "ls", [rule("bash", "ask")])
    expect(PermissionExplain.isDefault(only)).toBe(false)
  })

  test("spells the rule the way the explain command does", () => {
    // The prompt, the explain trace and `describeRule` are three views of one
    // decision; if they spell a rule differently the user is reading two
    // different rules.
    const [only] = PermissionExplain.matched("bash", "rm -rf", [rule("bash", "ask", "rm*")])
    expect(PermissionExplain.describeAsk([only])).toBe("Rule 1/1 (bash = ask)")
  })

  test("the prompt line says nothing was configured, rather than nothing at all", () => {
    const [only] = PermissionExplain.matched("bash", "ls", [rule("edit", "allow")])
    expect(PermissionExplain.describeAsk([only])).toBe("no rule covers this, so it defaults to ask")
  })

  test("stays silent with no reason, so a prompt never invents one", () => {
    expect(PermissionExplain.describeAsk(undefined)).toBeUndefined()
    expect(PermissionExplain.describeAsk([])).toBeUndefined()
  })

  test("agrees with the winner the explanation names", () => {
    const ruleset = [rule("*", "allow"), rule("bash", "deny"), rule("bash", "ask", "rm*")]
    const [only] = PermissionExplain.matched("bash", "rm -rf", ruleset)
    const explained = PermissionExplain.explain("bash", "rm -rf", ruleset)
    expect(only.rule).toEqual(explained.winner)
    expect(only.index).toBe(explained.winnerIndex)
    expect(only.total).toBe(explained.candidates.length)
  })

  test("gives the same answer whether or not an empty ruleset is in the middle", () => {
    const a = [rule("bash", "deny")]
    const b = [rule("bash", "ask", "ls*")]
    expect(PermissionExplain.matched("bash", "ls", a, b)).toEqual(PermissionExplain.matched("bash", "ls", a, [], b))
  })
})
