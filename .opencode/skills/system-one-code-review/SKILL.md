---
name: system-one-code-review
description: |
  Use when the user needs to review a code diff for security vulnerabilities
  and correctness bugs. Invokes the @system-one subagent with the code_review
  workflow to audit code changes and produce an approve/request_changes/block
  decision. Trigger phrases: "review this code", "code review", "audit this
  diff", "security review", "system one code review", "/system-one-code-review".
---

# System One Code Review — Security & Correctness Audit

## When to Use

Load this skill when the user wants to review a code diff using a local LLM
model. This skill delegates to the `@system-one` subagent with the
`code_review` workflow.

## Command

```
/system-one-code-review
```

## Subagent Configuration

- **Agent**: `@system-one`
- **Type**: `subagent`
- **Context**: `system-one`
- **Workflow**: `code_review`

## What It Does

Runs a single-call parallel prompt that audits the code across 3 fields:

| Field | Type | Values |
|-------|------|--------|
| `security.has_vuln` | boolean | true/false |
| `security.severity` | enum | none, low, medium, high, critical |
| `security.finding_type` | enum | none, injection, auth_bypass, data_exposure, crypto_weak, path_traversal, xss, other |
| `correctness.has_bug` | boolean | true/false |
| `correctness.severity` | enum | none, low, medium, high |
| `correctness.finding_type` | enum | none, null_deref, type_mismatch, logic_error, race_condition, resource_leak, off_by_one, other |
| `decision.decision` | enum | approve, request_changes, block |
| `decision.reason_category` | enum | clean, minor_issues, security_concern, correctness_bug, breaking_change, needs_tests, needs_docs, other |

## Usage

When the user invokes `/system-one-code-review` or asks to review code:

1. Extract the code diff from the user's message, clipboard, or PR context.
2. Delegate to `@system-one` subagent with:
   - `workflow`: `code_review`
   - `context`: The code diff formatted as context.
3. Return the structured review result (security findings, correctness bugs, final decision).

## Example Prompt to Subagent

```
Review this code diff using the code_review workflow:

```diff
+ function login(username, password) {
+   return db.query(`SELECT * FROM users WHERE name = '${username}' AND pass = '${password}'`);
+ }
```
```

## Implementation Notes

- Uses `CODE_REVIEW_PROMPT` from `packages/system-one-lite/src/core/parallel.ts`
- Single model call via GBNF grammar (~1.3s latency, 100% success rate)
- Default model: `qwen2.5-3b-instruct-q4_k_m.gguf` (2.4GB)
- Falls back to `WorkflowRunner.run()` if no parallel prompt is available

## Args Schema

```json
{
  "diff": "string"
}
```
