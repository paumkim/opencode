---
name: system-one-triage
description: |
  Use when the user needs to classify or triage a GitHub issue. Invokes the
  @system-one subagent with the issue_triage workflow to categorize issues
  by type, priority, area, estimated effort, and design review need.
  Trigger phrases: "triage this issue", "classify this issue", "what kind of
  issue is this", "system one triage", "/system-one-triage".
---

# System One Triage — Issue Classification

## When to Use

Load this skill when the user wants to classify a GitHub issue using a local
LLM model. This skill delegates to the `@system-one` subagent with the
`issue_triage` workflow.

## Command

```
/system-one-triage
```

## Subagent Configuration

- **Agent**: `@system-one`
- **Type**: `subagent`
- **Context**: `system-one`
- **Workflow**: `issue_triage`

## What It Does

Runs a single-call parallel prompt that classifies the issue across 5 fields:

| Field | Type | Values |
|-------|------|--------|
| `category` | enum | bug, feature, question, docs, refactor |
| `priority` | enum | P0, P1, P2, P3 |
| `area` | enum | frontend, backend, cli, docs, infra, unknown |
| `estimated_hours` | integer | 0–100 |
| `needs_design_review` | boolean | true/false |

## Usage

When the user invokes `/system-one-triage` or asks to triage an issue:

1. Extract the issue title and body from the user's message or context.
2. Delegate to `@system-one` subagent with:
   - `workflow`: `issue_triage`
   - `context`: The issue title and body formatted as context.
3. Return the structured classification result to the user.

## Example Prompt to Subagent

```
Classify this GitHub issue using the issue_triage workflow:

Title: Login fails with 500 error on Safari
Body: Users report login returns 500 only on Safari 17+. Works on Chrome/Firefox.
```

## Implementation Notes

- Uses `ISSUE_TRIAGE_PROMPT` from `packages/system-one-lite/src/core/parallel.ts`
- Single model call via GBNF grammar (~1.3s latency, 100% success rate)
- Default model: `qwen2.5-3b-instruct-q4_k_m.gguf` (2.4GB)
- Falls back to `WorkflowRunner.run()` if no parallel prompt is available

## Args Schema

```json
{
  "title": "string",
  "body": "string"
}
```
