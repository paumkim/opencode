import { describe, expect, test } from "bun:test"
import { buildSystemPrompt, PROMPT_ANTHROPIC, PROMPT_ASTRA, PROMPT_CODEX, PROMPT_DEFAULT, PROMPT_GEMINI, PROMPT_GPT, PROMPT_KIMI, PROMPT_META, PROMPT_TRINITY } from "@/session/prompt/system-prompts"

const VARIANTS = {
  default: PROMPT_DEFAULT,
  anthropic: PROMPT_ANTHROPIC,
  astra: PROMPT_ASTRA,
  codex: PROMPT_CODEX,
  gemini: PROMPT_GEMINI,
  gpt: PROMPT_GPT,
  kimi: PROMPT_KIMI,
  meta: PROMPT_META,
  trinity: PROMPT_TRINITY,
}

describe("the fundamental limits reach every model variant", () => {
  // Each prompt variant is selected by model id in `session/system.ts`, and every one of them is
  // passed through `buildSystemPrompt`. Adding the rules to a single variant would leave them off
  // for every other model, which is the drift this pins.
  for (const [name, base] of Object.entries(VARIANTS)) {
    test(`${name} carries the three limits and the one permission`, () => {
      const prompt = buildSystemPrompt(base)
      expect(prompt).toContain("THE FINAL IS FINAL")
      expect(prompt).toContain("YOU DO NOT DECIDE FOR THE USER")
      expect(prompt).toContain("YOU DO NOT DESTROY")
      expect(prompt).toContain("YOU MAY ALWAYS ASK FOR MORE")
    })

    test(`${name} states the permission as the inverse of a fixed allowance`, () => {
      const prompt = buildSystemPrompt(base)
      // The fourth rule inverts "you only get what you were given". Without that framing an agent
      // treats its budget as a ceiling to survive rather than a resource to ask to extend, and
      // stalls or truncates instead of asking - the exact failure the rule exists to prevent.
      expect(prompt).toContain("never to stall, silently narrow the task, or claim completion")
      expect(prompt).toContain("extend_goal")
    })

    test(`${name} wraps the rules as a system directive`, () => {
      expect(buildSystemPrompt(base)).toContain("<system_directive>")
    })
  }
})
