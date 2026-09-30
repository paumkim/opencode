import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "../../src/permission"
import { PermissionExplain } from "../../src/permission/explain"

const rule = (permission: string, action: PermissionV1.Action, pattern = "*"): PermissionV1.Rule => ({
  permission,
  action,
  pattern,
})

const explain = (permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]) =>
  PermissionExplain.explain(permission, pattern, ...rulesets)

const ids = (found: readonly PermissionExplain.Verdict[]) =>
  found.filter((item) => item.matches).map((item) => item.index)

describe("permissionExplain.explain", () => {
  test("names the rule that decided and says why it beat the others", () => {
    const result = explain("bash", "rm -rf", [rule("bash", "deny"), rule("bash", "ask", "rm*")])
    expect(result.defaulted).toBe(false)
    expect(result.winnerIndex).toBe(1)
    expect(result.winner).toEqual(rule("bash", "ask", "rm*"))
    expect(result.why).toContain("Rule 2 of 2")
    // The winning rule is also the last one in the file, which is a stronger
    // statement than "last of two matches" and is what the message says.
    expect(result.why).toContain("it is the last rule, so nothing can override it")
  })

  test("counts the rules a winner overrode when something follows it", () => {
    const result = explain("bash", "rm -rf", [
      rule("bash", "allow", "*"),
      rule("bash", "ask", "rm*"),
      rule("edit", "deny"),
    ])
    expect(result.winnerIndex).toBe(1)
    expect(result.why).toContain("last of 2 matching rules")
    expect(result.why).toContain("overrides the 1 above it")
  })

  test("keeps the whole ruleset, in order, with a verdict per rule", () => {
    const result = explain("edit", "src/a.ts", [
      rule("bash", "deny"),
      rule("edit", "ask", "src/*"),
      rule("edit", "allow", "src/a.ts"),
    ])
    expect(result.candidates).toHaveLength(3)
    expect(result.candidates[0]).toMatchObject({
      index: 0,
      permissionMatched: false,
      patternMatched: true,
      matches: false,
    })
    expect(result.candidates[1]).toMatchObject({
      index: 1,
      permissionMatched: true,
      patternMatched: true,
      matches: true,
    })
    expect(result.candidates[2]).toMatchObject({
      index: 2,
      permissionMatched: true,
      patternMatched: true,
      matches: true,
    })
  })

  test("separates the two ways a rule can fail, because they have different causes", () => {
    const result = explain("bash", "rm -rf", [rule("edit", "allow", "*"), rule("bash", "allow", "ls*")])
    // The first rule's `*` pattern covers any target, so what it fails on is the
    // tool, not the command.
    expect(result.candidates[0]).toMatchObject({ permissionMatched: false, patternMatched: true, matches: false })
    expect(result.candidates[1]).toMatchObject({ permissionMatched: true, patternMatched: false, matches: false })
    // The tool is covered, the command is not: that is the case a user reads as
    // "my rule is broken" when in fact it is scoped to something else.
    expect(result.why).toContain('1 rule covers "bash" but none of them covers "rm -rf"')
  })

  test("says nothing covers the permission at all when that is the case", () => {
    const result = explain("webfetch", "https://example.com", [rule("bash", "allow")])
    expect(result.defaulted).toBe(true)
    expect(result.winnerIndex).toBe(-1)
    expect(result.winner).toEqual({ action: "ask", permission: "webfetch", pattern: "*" })
    expect(result.why).toContain('No rule covers "webfetch"')
  })

  test("says so plainly when there are no rules at all", () => {
    const result = explain("bash", "ls")
    expect(result.why).toBe("No rules are configured, so everything falls through to ask.")
  })

  test("merges rulesets in order, so a later set overrides an earlier one", () => {
    const result = explain("bash", "ls", [rule("bash", "deny")], [rule("bash", "allow")])
    expect(result.winnerIndex).toBe(1)
    expect(result.winner.action).toBe("allow")
  })

  test("names a sole match as the only match, which is a different claim from last-of-many", () => {
    const result = explain("bash", "ls", [rule("bash", "deny"), rule("edit", "allow")])
    expect(result.why).toContain("only rule that matches")
  })

  test("treats * as a pattern on the permission name too", () => {
    const result = explain("context7_query-docs", "*", [rule("*_*", "deny")])
    expect(result.winnerIndex).toBe(0)
    expect(result.winner.action).toBe("deny")
  })

  test("reads a rule the way the decision does, without a trailing pattern when it is *", () => {
    expect(PermissionExplain.describeRule(rule("bash", "allow"))).toBe("bash allow")
    expect(PermissionExplain.describeRule(rule("bash", "ask", "rm*"))).toBe("bash ask rm*")
  })
})

describe("permissionExplain agrees with Permission.evaluate", () => {
  const cases: [string, string, readonly PermissionV1.Rule[]][] = [
    ["bash", "ls", [rule("bash", "deny")]],
    ["bash", "rm -rf", [rule("bash", "deny"), rule("bash", "allow", "ls*")]],
    ["bash", "ls", [rule("bash", "deny"), rule("bash", "allow", "ls*"), rule("bash", "ask", "l*")]],
    ["edit", "src/a.ts", [rule("bash", "allow"), rule("edit", "allow", "src/*")]],
    ["edit", "test/a.ts", [rule("bash", "allow"), rule("edit", "allow", "src/*")]],
    ["webfetch", "https://x.com", []],
    ["webfetch", "https://x.com", [rule("*", "deny")]],
    ["context7_query-docs", "*", [rule("*_*", "deny"), rule("context7_*", "allow")]],
    ["task", "reviewer", [rule("task", "deny", "reviewer"), rule("task", "allow", "*")]],
    ["lsp", "src", [rule("lsp", "ask", "src"), rule("lsp", "allow", "src"), rule("*", "deny")]],
  ]

  for (const [permission, pattern, ruleset] of cases) {
    test(`${permission} "${pattern}" over ${ruleset.length} rule(s)`, () => {
      const decided = Permission.evaluate(permission, pattern, ruleset)
      const explanation = explain(permission, pattern, ruleset)
      expect(explanation.winner).toEqual(decided)
      expect(explanation.defaulted).toBe(explanation.winnerIndex === -1)
    })
  }

  test("several rulesets are decided the same way whether or not the later one is empty", () => {
    const a = [rule("bash", "deny")]
    const b = [rule("bash", "allow", "ls*")]
    expect(Permission.evaluate("bash", "ls", a, b)).toEqual(Permission.evaluate("bash", "ls", a, [], b))
    expect(explain("bash", "ls", a, b).winner).toEqual(Permission.evaluate("bash", "ls", a, [], b))
  })
})

describe("permissionExplain.candidates", () => {
  test("returns only the matches, in evaluation order", () => {
    const found = PermissionExplain.candidates(
      "bash",
      "ls",
      [rule("bash", "deny"), rule("bash", "allow", "l*")],
      [rule("bash", "deny", "ls")],
    )
    expect(ids(found)).toEqual([0, 1, 2])
    expect(found.at(-1)!.rule).toEqual(rule("bash", "deny", "ls"))
  })
})
