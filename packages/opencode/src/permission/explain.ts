export * as PermissionExplain from "./explain"

import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"

/**
 * One rule in a ruleset, with the verdict on the question that was asked.
 *
 * Both halves are kept rather than a single `matches` flag because the two
 * halves fail for different reasons and a user chasing "why was I asked"
 * usually already suspects one of them: a permission name that does not match
 * means the rule was never about this tool, and a pattern that does not match
 * means it was about a different file, command or agent.
 */
export interface Verdict {
  /** Position in the flattened ruleset. Later rules override earlier ones. */
  readonly index: number
  readonly rule: PermissionV1.Rule
  readonly permissionMatched: boolean
  readonly patternMatched: boolean
  readonly matches: boolean
}

export interface Explanation {
  readonly permission: string
  readonly pattern: string
  /** Every rule that was considered, in evaluation order, winners included. */
  readonly candidates: readonly Verdict[]
  /** The rules that matched, in the order `evaluate` considered them. */
  readonly matched: readonly Verdict[]
  /** The decision, identical to what `evaluate` returned for the same input. */
  readonly winner: PermissionV1.Rule
  /** Where the winning rule sits in the ruleset; -1 when nothing matched. */
  readonly winnerIndex: number
  /** True when no rule matched and the implicit default decided it. */
  readonly defaulted: boolean
  /** A sentence naming the rule and the reason it beat the others. */
  readonly why: string
}

function verdictAt(index: number, rule: PermissionV1.Rule, permission: string, pattern: string): Verdict {
  const permissionMatched = Wildcard.match(permission, rule.permission)
  const patternMatched = Wildcard.match(pattern, rule.pattern)
  return { index, rule, permissionMatched, patternMatched, matches: permissionMatched && patternMatched }
}

/**
 * The rules that match a question, in the order they are considered.
 *
 * This is the single place a permission decision is made. `evaluate` is defined
 * in terms of it so that an explanation and the decision it explains cannot
 * drift apart: a trace that disagreed with the outcome would be worse than no
 * trace, because it would be believed.
 */
export function candidates(
  permission: string,
  pattern: string,
  ...rulesets: readonly PermissionV1.Ruleset[]
): Verdict[] {
  return rulesets.flat().map((rule, index) => verdictAt(index, rule, permission, pattern))
}

/** The last match wins, which is why order in the file is the whole story. */
export function winner(permission: string, pattern: string, ...rulesets: readonly PermissionV1.Ruleset[]) {
  return candidates(permission, pattern, ...rulesets).findLast((item) => item.matches)
}

/** The rule that decides when nothing matched: ask, for anything. */
export function fallback(permission: string): PermissionV1.Rule {
  return { action: "ask", permission, pattern: "*" }
}

export function explain(
  permission: string,
  pattern: string,
  ...rulesets: readonly PermissionV1.Ruleset[]
): Explanation {
  const all = candidates(permission, pattern, ...rulesets)
  const matched = all.filter((item) => item.matches)
  const best = matched.at(-1)
  return {
    permission,
    pattern,
    candidates: all,
    matched,
    winner: best?.rule ?? fallback(permission),
    winnerIndex: best?.index ?? -1,
    defaulted: !best,
    why: describe(all, matched, permission, pattern),
  }
}

function describe(all: readonly Verdict[], matched: readonly Verdict[], permission: string, pattern: string): string {
  if (matched.length === 0) {
    if (all.length === 0) return "No rules are configured, so everything falls through to ask."
    // A rule that matched the tool but not the target is the usual cause, and it
    // is invisible without saying which half failed.
    const forTool = all.filter((item) => item.permissionMatched)
    if (forTool.length > 0) {
      return (
        `${forTool.length} rule${forTool.length === 1 ? " covers" : "s cover"} "${permission}" but ` +
        `none of them${forTool.length === 1 ? " covers" : " cover"} "${pattern}", so nothing decided ` +
        `this and it falls through to ask.`
      )
    }
    return `No rule covers "${permission}", so nothing decided this and it falls through to ask.`
  }
  const best = matched[matched.length - 1]
  const beaten = matched.length - 1
  const source =
    best.index === all.length - 1
      ? "it is the last rule, so nothing can override it"
      : beaten === 0
        ? "it is the only rule that matches"
        : `it is the last of ${matched.length} matching rules, so it overrides the ${beaten} above it`
  return `Rule ${best.index + 1} of ${all.length} (${best.rule.permission} = ${best.rule.action}) decided this: ${source}.`
}

/**
 * Renders one ruleset line the way the decision reads it, for a report that
 * shows the whole file rather than one question about it.
 */
export function describeRule(rule: PermissionV1.Rule): string {
  return `${rule.permission} ${rule.action} ${rule.pattern === "*" ? "" : rule.pattern}`.trim()
}
