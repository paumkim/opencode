# Session LLM Runtime Boundaries

`../llm.ts` is the opencode session LLM service. It owns opencode concerns: auth, config, model/provider resolution, plugins, permissions, telemetry headers, and runtime selection. It is the only file in this area that should know about the full session request shape.

This folder contains adapters behind that service boundary:

- `ai-sdk.ts` converts AI SDK `fullStream` parts into `@opencode-ai/llm` `LLMEvent`s. This is the default runtime path.
- `native-request.ts` converts opencode's normalized session input into a native `@opencode-ai/llm` `LLMRequest`. It does not execute requests.
- `request.ts` normalizes the session request before runtime selection (`LLMRequestPrep.prepare`): system prompt, params, tools, headers. Both runtimes consume its output.
- `native-runtime.ts` is the opt-in native runtime adapter. It decides whether a selected model is supported, builds the native request, bridges opencode tools into native executable tools, and delegates transport to `LLMClient` / `RequestExecutor`.

## File Structure

```txt
src/session/
  llm.ts                    session-owned orchestration and runtime selection
  llm/
    AGENTS.md               boundary notes for the adapter layer
    ai-sdk.ts               AI SDK fullStream -> @opencode-ai/llm LLMEvent adapter
    native-request.ts       opencode/AI SDK-shaped input -> @opencode-ai/llm LLMRequest
    native-runtime.ts       native runtime gate, tool bridge, and LLMClient handoff
    request.ts              shared session request prep (LLMRequestPrep.prepare)
```

Integration points:

- `../llm.ts` imports `LLMClient` / `LLMClientService` from `@opencode-ai/llm/route` only to inject the client service into the native runtime; the actual `llmClient.stream(...)` call lives in `native-runtime.ts`.
- `../llm.ts` imports `LLMRequestPrep` from `./llm/request` and runs `LLMRequestPrep.prepare(...)` before runtime selection; both runtimes consume the prepared messages, tools, params, and headers.
- `../llm.ts` imports `LLMAISDK` from `./llm/ai-sdk`; the AI SDK path still calls `streamText(...)` locally, then adapts `result.fullStream` into shared `LLMEvent`s.
- `../llm.ts` imports `LLMNativeRuntime` from `./llm/native-runtime`; this is the runtime-selection seam. Unsupported native requests return a reason and fall back to AI SDK.
- `native-runtime.ts` imports `LLMNative` from `./native-request`; this keeps request lowering separate from transport and tool execution.
- `native-request.ts` is the only adapter file that should construct `LLM.request(...)`, provider models via `OpenAI`/`Azure`/`Anthropic`/`Google`/`AmazonBedrock`/`OpenAICompatible`/`OpenRouter` `.configure(...).model/responses(...)`, `Message.make`, `SystemPart`, `ToolCallPart`, `ToolResultPart`, or `ToolDefinition` values from `@opencode-ai/llm`.
- `ai-sdk.ts` and `native-runtime.ts` both emit `@opencode-ai/llm` `LLMEvent`s so downstream session processing does not care which runtime handled the request.

Keep new integration code on one of these seams. Avoid importing session services into `native-request.ts`; pass normalized data through `RequestInput` instead.

## Runtime selection

Both runtimes converge on the same `LLMEvent` stream consumed by the session processor. The gate is per-request: a single session can route some calls through native and fall back for others. Flow is `llm.ts` -> `LLMRequestPrep.prepare(...)` (`request.ts`) -> native gate -> `ai-sdk.ts` vs `native-runtime.ts` -> `native-request.ts` -> `LLMClient.stream(...)`.

```txt
                             ╭───────────────────╮
╭───────────────────────────▶│ session processor │
│                            ╰─────────┬─────────╯
│                                      │
│                                      │
│                                      │
│                                      ▼
│                         ╭─────────────────────────╮
│                         │ LLM.Service (../llm.ts) │
│                         ╰────────────┬────────────╯
│                                      │
│                                      │
│                                      │
│                                      ▼
│                                ╭───────────╮
│                              ╭─╯           ╰─╮
│                              │  native gate  │
│                              ╰─╮           ╭─╯
│                                ╰─────┬─────╯
│                                      │
│                     ╭────── no ──────┴─────── yes ────────╮
│                     │                                     │
│                     ▼                                     ▼
│       ╭───────────────────────────╮             ╭───────────────────╮
│       │          AI SDK           │             │ native-runtime.ts │
│       │ streamText / generateText │             ╰────────┬──────────╯
│       ╰─────────────┬─────────────╯                      │
│                     │                                    │
│                 ╭───╯                                    │
│                 │                                        │
│                 ▼                                        ▼
│     ╭───────────────────────╮             ╭────────────────────────────╮
│     │       ai-sdk.ts       │             │     native-request.ts      │
│     │ fullStream → LLMEvent │             │ session input → LLMRequest │
│     ╰──────────┬────────────╯             ╰──────────────┬─────────────╯
│                │                                         │
│                │                                     ╭───╯
│                │                                     │
│                ▼                                     ▼
│       ╭─────────────────╮             ╭─────────────────────────────╮
╰───────┤ LLMEvent stream │◀────────────┤ LLMClient · RequestExecutor │
        ╰─────────────────╯             ╰─────────────────────────────╯
```

`native-runtime.ts` evaluates the gate and either bridges into `@opencode-ai/llm` or returns control so `llm.ts` can take the AI SDK path. Tool execution stays opencode-owned in both branches; only request lowering and transport differ.

Safety boundary:

- AI SDK remains the default.
- `OPENCODE_EXPERIMENTAL_NATIVE_LLM=true` opts in (dedicated flag only; the umbrella `OPENCODE_EXPERIMENTAL=true` does not enable it). Native is not a global replacement.
- Native execution currently supports OpenAI, opencode-managed OpenAI-compatible, and Anthropic API-key paths backed by `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, or `@ai-sdk/anthropic` catalog entries.
- Unsupported providers, OpenAI OAuth without a provider fetch override, and missing API-key cases fall back to AI SDK.
