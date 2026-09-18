# Architecture Decisions

## Decision: TypeScript for System One Lite

**Date**: 2025
**Status**: Accepted

### Context

We need a local structured decision layer ("System One Lite") that:
- Runs on 6GB VRAM GPU
- Provides schema-enforced structured outputs (zero parse errors)
- Integrates natively with opencode (TypeScript codebase)
- Can be shipped as a single binary
- Supports calibration, workflows, parallel prompts

### Options Considered

| Language | Pros | Cons |
|----------|------|------|
| **TypeScript** | Native opencode integration, Zod for schema→types→GBNF, single binary via `bun build`, team familiarity | Slightly slower than Rust/C++ |
| **Python** | Rich ML ecosystem, Outlines/llama-cpp-python | Subprocess overhead, dependency hell, not native to opencode |
| **Rust** | Maximum performance, candle/llama.rs bindings | FFI complexity, not native to opencode, steeper learning |
| **Go** | Good concurrency, single binary | No native llama.cpp bindings, manual schema validation |

### Decision

**Use TypeScript (Node/Bun) for the core system, llama.cpp (C++) for inference.**

### Rationale

1. **Native integration**: opencode is TypeScript; subagents run in-process
2. **Type safety pipeline**: Zod schema → TypeScript types → GBNF grammar → validated output (end-to-end)
3. **Deployment**: `bun build --compile` produces single binary with no runtime dependencies
4. **VRAM constraint**: llama.cpp handles quantization/offloading; TS just orchestrates
5. **Team velocity**: No context switching, shared types with opencode
6. **Scalability**: Can add llama-server HTTP layer later without rewriting core

### Consequences

- **Positive**: Fast iteration, type-safe workflows, easy debugging, single binary deploy
- **Negative**: Slightly higher latency than pure Rust; mitigated by llama.cpp doing heavy lifting
- **Risk**: Bun maturity; mitigated by Node compatibility fallback

### Implementation Notes

- Core logic in `src/` (pure TS, no runtime deps except Zod)
- llama.cpp invoked via CLI (`llama-cli`) or native binding (`llama-node`)
- GBNF grammars generated from Zod schemas at build time
- Calibration algorithms implemented in pure TS (no sklearn needed)
- Workflows as type-safe compute graphs

---

## Future Decisions (to be made)

- [ ] llama.cpp binding: CLI vs native (`llama-node`) vs HTTP (`llama-server`)
- [ ] Calibration persistence format (JSON vs binary)
- [ ] Workflow definition format (TS code vs YAML vs JSON)
- [ ] Model registry format
- [ ] opencode subagent registration mechanism