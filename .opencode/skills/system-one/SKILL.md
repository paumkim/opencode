---
name: system-one
description: |
  Master skill for @system-one subagent routing. Use when the user needs
  structured decision-making via local LLM workflows. Routes to the three
  specific system-one skills: triage, code review, and release readiness.
  Load this skill when the user mentions "system one", "local model triage",
  "local code review", or "release readiness check" without specifying a
  particular workflow.
---

# System One — Structured Decision Making

## Overview

System One Lite provides structured decision-making using local LLM models
(llama.cpp) via the `@system-one` subagent. All workflows use a single-call
parallel prompt path for consistent ~1.3s latency and 100% success rate.

## Available Workflows

| Skill | Command | Workflow | Use Case |
|-------|---------|----------|----------|
| `system-one-triage` | `/system-one-triage` | `issue_triage` | Classify GitHub issues |
| `system-one-code-review` | `/system-one-code-review` | `code_review` | Audit code for security/correctness |
| `system-one-release-readiness` | `/system-one-release-readiness` | `release_readiness` | Assess release readiness |

## Routing

When the user's request matches one of the three workflows above, load the
corresponding skill and delegate to `@system-one` with the appropriate workflow.

If the user does not specify a workflow, ask which one they need, or default
to `issue_triage` for GitHub-related tasks.

## Subagent Reference

- **Agent**: `@system-one` (type: `subagent`, context: `system-one`)
- **Package**: `packages/system-one-lite`
- **Entry point**: `src/integration/subagent.ts`
- **Factory**: `createSystemOneAgent(config)`

## Configuration

The subagent accepts the following config (from `OPENCODE_AGENT_MANIFEST`):

```json
{
  "backend": "llama.cpp",
  "modelPath": "./models/qwen2.5-3b-instruct-q4_k_m.gguf",
  "ctxSize": 4096,
  "ngl": 999,
  "temperature": 0.0,
  "maxTokens": 512,
  "binaryPath": "llama-completion",
  "defaultWorkflow": "issue_triage",
  "autoSelectModel": false
}
```

## Quick Reference

- `/system-one-triage` — classify GitHub issues (bug/feature/docs/etc.)
- `/system-one-code-review` — audit code diffs for security and correctness
- `/system-one-release-readiness` — assess if a release candidate is ready
