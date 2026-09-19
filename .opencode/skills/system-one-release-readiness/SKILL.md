---
name: system-one-release-readiness
description: |
  Use when the user needs to assess whether a release candidate is ready to
  ship. Invokes the @system-one subagent with the release_readiness workflow
  to evaluate test results, breaking changes, migration needs, and overall
  confidence. Trigger phrases: "is this ready to release", "release readiness",
  "can we ship this", "check release", "system one release", "/system-one-release-readiness".
---

# System One Release Readiness — Ship Decision

## When to Use

Load this skill when the user wants to assess release readiness using a local
LLM model. This skill delegates to the `@system-one` subagent with the
`release_readiness` workflow.

## Command

```
/system-one-release-readiness
```

## Subagent Configuration

- **Agent**: `@system-one`
- **Type**: `subagent`
- **Context**: `system-one`
- **Workflow**: `release_readiness`

## What It Does

Runs a single-call parallel prompt that evaluates release readiness across 4 fields:

| Field | Type | Values |
|-------|------|--------|
| `tests_pass` | boolean | true/false |
| `breaking_changes` | boolean | true/false |
| `migration_needed` | boolean | true/false |
| `confidence` | number | 0.0–1.0 |

## Usage

When the user invokes `/system-one-release-readiness` or asks about release readiness:

1. Extract the release version, changelog, and test results from the user's message or context.
2. Delegate to `@system-one` subagent with:
   - `workflow`: `release_readiness`
   - `context`: The version, changelog, and test results formatted as context.
3. Return the structured readiness assessment to the user.

## Example Prompt to Subagent

```
Evaluate release readiness using the release_readiness workflow:

Release candidate: v2.4.0
Changes:
- Fixed login 500 error on Safari
- Added dark mode toggle
- Updated dependencies

Test results: All 142 tests passing, 0 failures.
```

## Implementation Notes

- Uses `RELEASE_READINESS_PROMPT` from `packages/system-one-lite/src/core/parallel.ts`
- Single model call via GBNF grammar (~1.3s latency, 100% success rate)
- Default model: `qwen2.5-3b-instruct-q4_k_m.gguf` (2.4GB)
- Falls back to `WorkflowRunner.run()` if no parallel prompt is available

## Args Schema

```json
{
  "version": "string",
  "changelog": "string",
  "testResults": "string"
}
```
