# Handoff — harness tool-parsing work

## Status
All LLM-package tests pass (344 tests, 0 fail). Core-package typecheck has
**pre-existing** errors unrelated to this work (`projector.ts`, `SessionContextEpoch`,
`provider-alibaba.test.ts`) — these fail on clean HEAD too. My changes in
`packages/core/src/tool/tool.ts` are typecheck-clean.

## What was done

### 1. Multi-format text tool-call parsing (packages/llm)
- `src/protocols/utils/text-tool-call.ts` — rewritten to parse THREE formats
  instead of one:
  - `dots_function_call` / `invoke` / `parameter` (original)
  - `<tool_call>{"name":..,"arguments":{..}}</tool_call>` (qwen, deepseek, gateways)
  - `<function name=".."><parameter name="..">VALUE` legacy XML
  - Each detector runs independently; results merge in stable order.
  - Close tags are OPTIONAL (`<function>` / `<parameter>` / `<tool_call>` all allow
    stream-tail truncation) so the last call in a truncated stream isn't dropped.
- `src/protocols/utils/text-reasoning.ts` — extracted reasoning envelope parsing
  (was inline in openai-chat.ts).

### 2. Opt-in per-model extraction (packages/llm/src/protocols/openai-chat.ts)
- `ParserState` gained `textToolCall` / `textReasoning` booleans, seeded from
  `request.model.compatibility?.textToolCall` / `textReasoning`.
- `finishEvents` only runs the envelope parsers when those flags are set.
  Native structured providers (OpenAI, DeepSeek, etc.) never run it, so a stray
  `<thinking>` block in ordinary chat text is left untouched.
- Fixed a pre-existing regression: `finishEvents` was re-emitting assistant text
  that `step` had already streamed via `Lifecycle.textDelta`, duplicating output
  (broke 3 tests: "parses text and usage", "parses OpenAI-compatible reasoning",
  "assembles streamed tool call input"). Text is no longer re-emitted at halt.

### 3. Schema auto-correction (packages/llm + packages/core)
- NEW `src/protocols/utils/tool-correct.ts` — `correctToolInput(raw, schema)`:
  - missing required keys → filled with `undefined`
  - `null` where a scalar is expected → dropped
  - stringified JSON inside a string field → parsed and merged
  - unknown keys preserved untouched
  - returns `{ ok, repaired, input, message }`
- NEW `test/tool-correct.test.ts` (7 tests, all pass).
- `src/index.ts` re-exports `correctToolInput`.
- `packages/core/src/tool/tool.ts` `settle()` now calls `correctToolInput`
  before decoding; repaired failures surface as `ToolFailure` messages tagged
  `(repaired: ...)` so the model self-corrects on the next turn.

### 4. Tests
- NEW `test/text-extract.test.ts` (9 tests: 7 tool-call formats + 2 reasoning).
- NEW `test/tool-correct.test.ts` (7 tests).
- All 344 LLM tests pass; LLM typecheck clean.

## Key design decisions / gotchas
- **Don't run envelope parsing unconditionally.** It was tempting to make
  `TextToolCall.parse` always-on, but that would rewrite normal prose for the
  ~90% of models that emit structured tool calls. The opt-in via
  `ModelCompatibility` keeps the auto-correction from breaking the majority.
- **`Schema.toJsonSchemaDocument` lives on `Schema`, not a top-level export.**
  Use `Schema.toJsonSchemaDocument(schema).schema`.
- **`correctToolInput` is imported from `@opencode-ai/llm`** (re-exported from
  `src/index.ts`), not the deep path.
- The `text-tool-call.ts` / `text-reasoning.ts` / `tool-correct.ts` files are
  NEW (untracked → now committed).

## To verify
```
cd packages/llm && bun test ./test          # 350 pass, 0 fail
cd packages/llm && bun run typecheck        # only pre-existing errors in script/recording-cost-report.ts
cd packages/core && bun run typecheck      # only pre-existing errors expected
```

## Status of the "Next steps" list
- **Wire `correctToolInput` into the runner** — DONE (commit `df38c7087`).
  `settle()` in `packages/core/src/tool/tool.ts` already runs it, and the
  runner path through `toolMaterialization.settle` (`packages/core/src/session/runner/llm.ts:258`)
  propagates the repaired input. Verified by
  `packages/core/test/session-runner-tool-registry.test.ts` (18 pass).
- **Recorded golden scenario for a text-tool-call provider** — NOT done, and
  not easily: there is no dots / nex-agi provider facade in `packages/llm/src/providers/`,
  and recorded-golden requires a live HTTP cassette. The equivalent behavior
  is now locked instead through mock-HTTP protocol tests (see below), which
  is deterministic and doesn't need a live provider.
- **Expose `ModelCompatibility` on provider facades** — PARTIALLY done.
  `Model.update(model, { compatibility: { textToolCall: "dots" } })` and
  `route.with(...).model({ id, compatibility })` both work today (the type is
  already on `RouteModelInput`). The gap is only ergonomic: the typed facade
  factories (`OpenAI.chat`, `Anthropic.model`, etc.) narrow their argument to
  `{ id }`, so users can't pass `compatibility` through them directly.

## Work done since this handoff (commit `a838155aa`)
- **`packages/llm/src/protocols/utils/text-tool-call.ts`** — `parseToolCallTag`
  now decodes each `<tool_call>` envelope defensively (`safeDecode`). A single
  malformed JSON blob used to throw a `SchemaError` out of `parse`, crashing
  the whole turn and dropping every well-formed call in it. That made the
  handoff's `correctToolInput` repair path unreachable for text-tool-call
  providers. Malformed envelopes are now skipped; well-formed ones still land.
- **`packages/llm/test/text-extract.test.ts`** — 2 new tests for the
  malformed-JSON resilience (complete tag + stream-tail).
- **`packages/llm/test/provider/openai-chat.test.ts`** — new `describe("text-embedded tool calls (opt-in)")` block, 4 end-to-end tests through the real
  OpenAI Chat protocol with a mock SSE response:
  - extracts a `dots_function_call` envelope
  - extracts a `<tool_call>` JSON envelope
  - leaves prose untouched for native structured providers (no compatibility flag)
  - one malformed envelope does not drop the well-formed ones

## Still open
- Widen the provider-facade model factories to accept `compatibility` so a
  user can opt a model into text extraction without post-processing the model
  object or editing the catalog.
- A live dots / nex-agi provider facade + recorded golden scenario, if a
  real endpoint becomes available.