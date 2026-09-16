import { beforeEach, describe, expect, test } from "bun:test"
import {
  buildResumePrompt,
  clearSubagentFailover,
  isRetryableSubagentError,
  markSubagentModelFailed,
  resolveSubagentChain,
} from "../../src/session/subagent-failover"

const p = (providerID: string, modelID: string) => ({ providerID, modelID } as any)

describe("subagent-failover", () => {
  beforeEach(() => {
    clearSubagentFailover()
    delete process.env.OPENCODE_SUBAGENT_FALLBACKS
  })
  test("builds chain: agent → parent → small → env", () => {
    process.env.OPENCODE_SUBAGENT_FALLBACKS = "kilo/nex-agi/nex-n2.5-mini:free,anthropic/claude-haiku-4-5"
    const chain = resolveSubagentChain({
      subagentType: "general",
      parent: p("anthropic", "claude-sonnet-4-6"),
      agentModel: p("openai", "gpt-5"),
      smallModel: p("anthropic", "claude-haiku-4-5"),
    })
    expect(chain.map((m) => `${m.providerID}/${m.modelID}`)).toEqual([
      "openai/gpt-5",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-haiku-4-5",
      "kilo/nex-agi/nex-n2.5-mini:free",
    ])
    delete process.env.OPENCODE_SUBAGENT_FALLBACKS
  })

  test("skips cooled-down models unless all are cooled", () => {
    const a = p("a", "m")
    const b = p("b", "m")
    markSubagentModelFailed(a)
    const chain = resolveSubagentChain({
      subagentType: "general",
      parent: b,
      agentModel: a,
    })
    expect(chain).toEqual([b])
    markSubagentModelFailed(b)
    const chain2 = resolveSubagentChain({
      subagentType: "general",
      parent: b,
      agentModel: a,
    })
    expect(chain2).toEqual([a, b])
  })

  test("classifies retryable errors", () => {
    expect(isRetryableSubagentError("429 rate limit")).toBe(true)
    expect(isRetryableSubagentError("quota exceeded")).toBe(true)
    expect(isRetryableSubagentError("free usage limit reached")).toBe(true)
    expect(isRetryableSubagentError("503 service unavailable")).toBe(true)
    expect(isRetryableSubagentError("ECONNRESET")).toBe(true)
    expect(isRetryableSubagentError("timeout")).toBe(true)
    expect(isRetryableSubagentError("doom_loop detected")).toBe(true)
    expect(isRetryableSubagentError("network connection lost")).toBe(true)
  })

  test("does not retry non-retryable errors", () => {
    expect(isRetryableSubagentError("Subagent depth limit reached")).toBe(false)
    expect(isRetryableSubagentError("Unknown agent type: foo")).toBe(false)
    expect(isRetryableSubagentError("The user rejected permission")).toBe(false)
    expect(isRetryableSubagentError("401 invalid api key")).toBe(false)
    expect(isRetryableSubagentError("403 forbidden")).toBe(false)
  })

  test("first attempt returns prompt unchanged", () => {
    const out = buildResumePrompt({
      prompt: "do the thing",
      attempt: 0,
      failedModel: p("a", "m"),
      error: "x",
    })
    expect(out).toBe("do the thing")
  })

  test("later attempts prepend a resume note", () => {
    const out = buildResumePrompt({
      prompt: "do the thing",
      attempt: 1,
      failedModel: p("a", "m"),
      error: "429 rate limit",
    })
    expect(out).toContain("do the thing")
    expect(out).toContain("Resume note (attempt 2)")
    expect(out).toContain("a/m")
    expect(out).toContain("429 rate limit")
    expect(out).toContain("Verify files on disk before redoing work")
  })
})