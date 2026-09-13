# Context Management

## Overview

OpenCode manages conversation context through three cooperating mechanisms:

1. **Checkpoints** — durable snapshots of conversation state that allow recovery after interruption or process restart.
2. **Decisions log** — a structured summary (produced during compaction) that captures objectives, constraints, work state, and next steps so the model can resume without re-reading the full transcript.
3. **Compaction** — the process that produces the decisions log by summarizing older conversation turns into a compact representation, freeing context window for continued work.

Together these let a session run for hundreds of turns without exhausting the model's context window. The system is designed so that **free-tier models** (small context windows, cost-sensitive) get aggressive compaction by default, while **paid-tier models** (large context windows, cost-insensitive) can relax those settings.

## Architecture

### How the three mechanisms interact

```
Conversation grows → context usage approaches threshold → compaction triggers
                                                                   │
                                                                   ▼
                                              ┌─────────────────────────────────┐
                                              │  1. Select recent turns to keep  │
                                              │     (tail_turns / keep.tokens)   │
                                              └──────────────┬──────────────────┘
                                                             │
                                                             ▼
                                              ┌─────────────────────────────────┐
                                              │  2. Serialize older turns into   │
                                              │     a text prompt for the model  │
                                              └──────────────┬──────────────────┘
                                                             │
                                                             ▼
                                              ┌─────────────────────────────────┐
                                              │  3. Call the compaction model to  │
                                              │     produce a structured summary │
                                              └──────────────┬──────────────────┘
                                                             │
                                                             ▼
                                              ┌─────────────────────────────────┐
                                              │  4. Store the summary + recent   │
                                              │     context as a checkpoint      │
                                              └──────────────┬──────────────────┘
                                                             │
                                                             ▼
                                              ┌─────────────────────────────────┐
                                              │  5. On next turn, inject the     │
                                              │     checkpoint as a system      │
                                              │     message, replacing the      │
                                              │     compacted history           │
                                              └─────────────────────────────────┘
```

### Checkpoint lifecycle

| Stage | What happens | Where it is stored |
|-------|-------------|-------------------|
| **Trigger** | Context usage exceeds `threshold` (default 0.89) before a provider turn | In-memory estimate |
| **Selection** | Recent turns (up to `tail_turns` or `keep.tokens`) are kept verbatim; older turns are serialized into text | In-memory |
| **Summary** | The compaction model is called with a structured prompt to produce a summary | Model response |
| **Checkpoint** | The summary + serialized recent context is stored as a `compaction` message in session history | SQLite (durable) |
| **Injection** | On the next provider turn, the checkpoint is rendered as a `<conversation-checkpoint>` system message | Model-visible context |

### Decisions log format

The compaction summary follows a fixed template so the model always knows where to find key information:

```markdown
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
- Completed: [finished work, verified facts, changes made; otherwise "(none)"]
- Active: [current work, partial changes, or investigation state; otherwise "(none)"]
- Blocked: [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]
```

The model is instructed to preserve exact file paths, symbols, commands, error strings, URLs, and identifiers within the relevant sections.

### Pruning

When `prune` is enabled, OpenCode additionally strips the output of old completed tool calls (beyond a protected window of 40,000 tokens) to reclaim context. Pruning only removes tool *output* — the tool call itself and its result metadata remain. The `skill` tool is always protected from pruning.

| Constant | Value | Purpose |
|----------|-------|---------|
| `PRUNE_MINIMUM` | 20,000 tokens | Minimum reclaimed tokens before pruning is applied |
| `PRUNE_PROTECT` | 40,000 tokens | Token window of recent tool calls to protect from pruning |
| `TOOL_OUTPUT_MAX_CHARS` | 2,000 chars | Per-tool-output truncation during serialization |

## Configuration

### Free-model configuration (aggressive)

When using free or low-cost models with small context windows, configure aggressive compaction to stay within budget:

```jsonc
{
  "compaction": {
    "auto": true,
    "prune": true,
    "tail_turns": 1,
    "preserve_recent_tokens": 2000,
    "reserved": 4000,
    "threshold": 0.75
  },
  "agent": {
    "compaction": {
      "model": "openai/gpt-4o-mini",
      "options": { "maxOutputTokens": 1024 }
    },
    "summary": {
      "model": "openai/gpt-4o-mini"
    }
  },
  "experimental": {
    "checkpoint": {
      "enabled": true,
      "auto": true
    }
  }
}
```

**Field reference (V1 schema):**

| Field | Default | Description |
|-------|---------|-------------|
| `compaction.auto` | `true` | Enable automatic compaction when context is full |
| `compaction.prune` | `false` | Enable pruning of old tool outputs |
| `compaction.tail_turns` | `2` | Number of recent user turns (with their assistant/tool responses) to keep verbatim |
| `compaction.preserve_recent_tokens` | `min(8000, max(2000, usable * 0.25))` | Maximum tokens from recent turns to preserve verbatim |
| `compaction.reserved` | `20000` | Token buffer reserved to avoid overflow during compaction |
| `compaction.threshold` | `0.89` | Context usage fraction (0–1) that triggers auto-compaction |
| `agent.compaction.model` | session model | Model used for the compaction summary call |
| `agent.summary.model` | session model | Model used for summary generation |
| `experimental.checkpoint.enabled` | `false` | Enable checkpoint saving for agent recovery |
| `experimental.checkpoint.auto` | `false` | Automatically create checkpoints at key points |

### Paid-model configuration (relaxed)

When using paid models with large context windows, relax compaction to preserve more verbatim history:

```jsonc
{
  "compaction": {
    "auto": true,
    "prune": true,
    "tail_turns": 4,
    "preserve_recent_tokens": 8000,
    "reserved": 16000,
    "threshold": 0.95
  },
  "agent": {
    "compaction": {
      "model": "anthropic/claude-3-5-sonnet-20241022",
      "options": { "maxOutputTokens": 4096 }
    },
    "summary": {
      "model": "anthropic/claude-3-5-sonnet-20241022"
    }
  },
  "experimental": {
    "checkpoint": {
      "enabled": true,
      "auto": true
    }
  }
}
```

### V2 schema differences

The V2 config schema (used by the new Effect-native core) renames several compaction fields:

| V1 field | V2 field |
|----------|----------|
| `compaction.preserve_recent_tokens` | `compaction.keep.tokens` |
| `compaction.reserved` | `compaction.buffer` |
| `compaction.tail_turns` | *(removed — replaced by `keep.tokens`)* |
| `experimental.checkpoint` | *(not yet ported to V2)* |

V2 compaction defaults: `buffer = 20000`, `keep.tokens = 8000`, `threshold = 0.89`.

In V2, the compaction model is always the session's active model — there is no separate `agent.compaction.model` override. The V2 `experimental` block only supports `policies` (provider allow/deny rules); checkpoint configuration is not yet available.

## Workflow

### Daily usage

1. **Start a session** — OpenCode loads config from `opencode.json` / `opencode.jsonc` in the project root, `.opencode/` directory, and global config directory. Settings are merged with closer directories taking precedence.

2. **Work normally** — As you interact, the conversation grows. OpenCode estimates token usage before each provider turn.

3. **Automatic compaction** — When estimated context usage exceeds `threshold`, OpenCode:
   - Keeps the last `tail_turns` user turns verbatim
   - Serializes older turns into a text prompt
   - Calls the compaction model to produce a structured summary
   - Stores the summary as a checkpoint message
   - Injects the checkpoint as a `<conversation-checkpoint>` system message on the next turn

4. **Manual compaction** — If automatic compaction fails (e.g., provider error), OpenCode attempts one overflow-triggered compaction. A second failure becomes a terminal error.

5. **Checkpoints** — When `experimental.checkpoint.auto` is enabled, checkpoints are created at key points (e.g., after compaction completes, at subagent boundaries). These are stored durably and can be used to resume after interruption.

### Reading the decisions log

The compaction summary appears in the model-visible context as:

```xml
<conversation-checkpoint>
The following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.

<summary>
## Objective
- [summary content]

## Important Details
- [details]

## Work State
- Completed: [work]
- Active: [current work]
- Blocked: [blockers]

## Next Move
1. [next action]
</summary>

<recent-context>
[serialized recent turns]
</recent-context>
</conversation-checkpoint>
```

The model treats this as historical context — it does not re-execute the summarized work but uses it to inform the current turn.

### When compaction triggers

| Condition | Behavior |
|-----------|----------|
| Context usage > `threshold` before a turn | Automatic compaction runs |
| Provider returns context-overflow error | One overflow-triggered compaction attempt |
| Compaction model fails or returns empty | Falls back to previous history boundary; no loop |
| Second overflow after compaction | Terminal failure — session stops |

## Scaling Guide

### Moving from free to paid models

When upgrading from a free model (e.g., `gpt-4o-mini`) to a paid model (e.g., `claude-3-5-sonnet`):

1. **Increase `tail_turns`** from `1` to `3–4` — paid models handle larger context, so keeping more verbatim turns improves fidelity.
2. **Increase `preserve_recent_tokens`** from `2000` to `8000` — more recent context is preserved without summarization.
3. **Increase `reserved`** from `4000` to `16000` — larger buffer prevents overflow during compaction with bigger models.
4. **Raise `threshold`** from `0.75` to `0.90–0.95` — paid models have larger windows, so compaction can wait longer.
5. **Switch the compaction model** to the paid model — higher-quality summaries reduce information loss.
6. **Increase `maxOutputTokens`** for the compaction agent — more output tokens means more detailed summaries.

### Moving from paid to free models

When downgrading from a paid model to a free model:

1. **Decrease `tail_turns`** to `1` — minimize verbatim history.
2. **Decrease `preserve_recent_tokens`** to `2000` — keep only the most essential recent context.
3. **Decrease `reserved`** to `4000` — smaller buffer is sufficient for smaller models.
4. **Lower `threshold`** to `0.70–0.75` — trigger compaction earlier to stay within the smaller window.
5. **Use a small model for compaction** (e.g., `gpt-4o-mini`) — keeps compaction costs low.
6. **Reduce `maxOutputTokens`** to `1024` — shorter summaries are cheaper and sufficient for smaller context.

### Quick reference table

| Setting | Free model | Paid model |
|---------|-----------|------------|
| `tail_turns` | `1` | `4` |
| `preserve_recent_tokens` | `2000` | `8000` |
| `reserved` | `4000` | `16000` |
| `threshold` | `0.75` | `0.95` |
| Compaction model | `gpt-4o-mini` | `claude-3-5-sonnet` |
| `maxOutputTokens` | `1024` | `4096` |
| `prune` | `true` | `true` |
| `checkpoint.enabled` | `true` | `true` |
| `checkpoint.auto` | `true` | `true` |
