import { describe, expect, test } from "bun:test"
import { Token } from "@opencode-ai/core/util/token"
import { SessionPromptSize } from "../../src/session/prompt-size"

const part = (
  piece: SessionPromptSize.Piece,
  tokens: number | null,
  present = tokens !== null,
): SessionPromptSize.Part => ({
  piece,
  tokens,
  detail: piece,
  present,
})

const tool = (name: string, over: Partial<SessionPromptSize.Tool> = {}): SessionPromptSize.Tool => ({
  name,
  tokens: 100,
  description: 400,
  schema: 0,
  ...over,
})

const ids = (input: Parameters<typeof SessionPromptSize.analyze>[0]) =>
  SessionPromptSize.analyze(input).map((finding) => finding.id)

describe("sessionPromptSize.assemble", () => {
  test("sends the pieces in the order the request does", () => {
    expect(
      SessionPromptSize.partsOf({
        agent: "build",
        hasAgentPrompt: true,
        env: ["env"],
        instructions: ["agents"],
        mcp: "mcp",
        skills: "skills",
      }).map((item) => item.piece),
    ).toEqual(["agent", "environment", "instructions", "mcp", "skills"])
  })

  test("names the built-in prompt when the agent has none of its own", () => {
    const parts = SessionPromptSize.partsOf({ agent: "build", hasAgentPrompt: false, providerPrompt: "base" })
    expect(parts[0].piece).toBe("provider")
    expect(parts[0].tokens).toBe(1)
    expect(parts[0].detail).toContain("built-in")
  })

  test("an agent's own prompt replaces the built-in one rather than adding to it", () => {
    // Sending both would mean the agent reads two sets of instructions, one of
    // which it was written to ignore.
    const parts = SessionPromptSize.partsOf({
      agent: "reviewer",
      hasAgentPrompt: true,
      providerPrompt: "base",
    })
    expect(parts.filter((item) => item.piece === "provider")).toEqual([])
    expect(parts[0].detail).toContain("replacing")
  })

  test("reports a piece that contributed nothing as absent, not as zero", () => {
    const parts = SessionPromptSize.partsOf({ agent: "build", hasAgentPrompt: false, providerPrompt: "base" })
    const mcp = parts.find((item) => item.piece === "mcp")
    expect(mcp?.present).toBe(false)
    expect(mcp?.tokens).toBeNull()
  })

  test("measures the environment across both of its parts", () => {
    const parts = SessionPromptSize.partsOf({
      agent: "build",
      hasAgentPrompt: false,
      env: ["a".repeat(40), "b".repeat(40)],
    })
    expect(parts.find((item) => item.piece === "environment")?.tokens).toBe(20)
  })

  test("lists the per-turn pieces rather than pretending they do not exist", () => {
    const parts = SessionPromptSize.partsOf({ agent: "build", hasAgentPrompt: true })
    expect(parts.length).toBeGreaterThan(0)
    expect(SessionPromptSize.PER_TURN.map((item) => item.piece)).toEqual(["crew", "system-one"])
    for (const item of SessionPromptSize.PER_TURN) {
      expect(item.present).toBe(false)
      expect(item.tokens).toBeNull()
      expect(item.detail).toContain("per turn")
    }
  })

  test("sizes the agent's own prompt rather than its name", () => {
    // The request sends `agent.prompt` as the base prompt in place of the
    // built-in one, so that text is what a report has to measure. Measuring the
    // name reported "3 tokens of agent prompt" for an eleven-character name.
    const parts = SessionPromptSize.partsOf({
      agent: "orchestrator",
      hasAgentPrompt: true,
      agentPrompt: "x".repeat(4_000),
    })
    expect(parts[0].piece).toBe("agent")
    expect(parts[0].tokens).toBe(1_000)
  })
})

describe("sessionPromptSize.totalOf", () => {
  test("adds the pieces that exist and skips the ones that do not", () => {
    expect(
      SessionPromptSize.totalOf([
        part("agent", 100),
        part("mcp", null, false),
        part("skills", 40),
        part("crew", null, false),
      ]),
    ).toBe(140)
  })

  test("is zero for a prompt with nothing in it", () => {
    expect(SessionPromptSize.totalOf([part("agent", null, false)])).toBe(0)
  })
})

describe("sessionPromptSize.measureTool", () => {
  test("sizes the tool as the provider receives it, schema included", () => {
    const measured = SessionPromptSize.measureTool({
      id: "bash",
      description: "run a command",
      jsonSchema: { type: "object", properties: { command: { type: "string" } } },
    })
    expect(measured.name).toBe("bash")
    // The wire form wraps the description and schema in a type and name, so it
    // is never smaller than the two of them together.
    expect(measured.tokens).toBeGreaterThan(measured.description / 4)
    expect(measured.schema).toBeGreaterThan(0)
  })

  test("keeps the description and the schema apart, because only one is a choice", () => {
    const measured = SessionPromptSize.measureTool({ id: "read", description: "x".repeat(400), jsonSchema: {} })
    expect(measured.description).toBe(400)
    expect(measured.schema).toBe(2)
  })

  test("survives a tool with no description, which is a real defect in a tool not in the report", () => {
    const measured = SessionPromptSize.measureTool({ id: "mystery", description: "", jsonSchema: {} })
    expect(measured.description).toBe(0)
    expect(measured.tokens).toBeGreaterThan(0)
  })

  test("sizes an unserializable schema rather than dropping the tool", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const measured = SessionPromptSize.measureTool({ id: "broken", description: "x", jsonSchema: cyclic })
    expect(measured.name).toBe("broken")
    expect(measured.schema).toBe(2)
  })
})

describe("sessionPromptSize.analyze", () => {
  const base = { parts: [] as SessionPromptSize.Part[], tools: [] as SessionPromptSize.Tool[], total: 0, toolsTotal: 0 }

  test("names project instructions that cost more than the base prompt", () => {
    // This is the one part of a prompt the user wrote themselves, and the one
    // part they can shorten, so it is the one worth naming.
    const findings = SessionPromptSize.analyze({
      ...base,
      parts: [part("provider", 500), part("instructions", 8_000)],
      total: 8_500,
    })
    const dominant = findings.find((finding) => finding.id === "prompt.instructions-dominate")
    expect(dominant?.title).toContain("8.0k")
    expect(dominant?.hint).toContain("cheapest context")
  })

  test("leaves instructions alone when they are the smaller half", () => {
    expect(
      ids({ ...base, parts: [part("provider", 20_000), part("instructions", 1_000)], total: 21_000 }),
    ).not.toContain("prompt.instructions-dominate")
  })

  test("says nothing about instructions when there are none", () => {
    expect(
      ids({ ...base, parts: [part("provider", 1_000), part("instructions", null, false)], total: 1_000 }),
    ).not.toContain("prompt.instructions-dominate")
  })

  test("names tool definitions that are most of what is sent up front", () => {
    // `total` is what the request carries, tool definitions included, so the
    // parts passed here include the tools row the way the service builds it.
    const findings = SessionPromptSize.analyze({
      ...base,
      parts: [part("agent", 1_000), part("tools", 5_000)],
      tools: [tool("bash", { tokens: 5_000 })],
      total: 6_000,
      toolsTotal: 5_000,
    })
    const dominant = findings.find((finding) => finding.id === "prompt.tools-dominate")
    expect(dominant?.title).toContain("83%")
    expect(dominant?.detail).toContain("bash")
  })

  test("counts the tool share against a total that already includes the tools", () => {
    // Tools at 55% of everything sent up front. Scoring them as a share of
    // `total + toolsTotal` gave 37% and the finding stayed silent, so the gate
    // could not fire for anything short of two thirds.
    expect(
      ids({
        ...base,
        parts: [part("agent", 10_000), part("tools", 12_000)],
        total: 22_000,
        toolsTotal: 12_000,
      }),
    ).toContain("prompt.tools-dominate")
  })

  test("still says nothing about a large share of a tiny prompt", () => {
    expect(
      ids({
        ...base,
        parts: [part("agent", 100)],
        tools: [tool("bash", { tokens: 3_000 })],
        total: 100,
        toolsTotal: 3_000,
      }),
    ).not.toContain("prompt.tools-dominate")
  })

  test("leaves tools alone when the prompt dominates them", () => {
    expect(
      ids({
        ...base,
        parts: [part("agent", 50_000)],
        tools: [tool("bash", { tokens: 1_000 })],
        total: 50_000,
        toolsTotal: 1_000,
      }),
    ).not.toContain("prompt.tools-dominate")
  })

  test("names one description long enough to be worth reading", () => {
    const findings = SessionPromptSize.analyze({
      ...base,
      parts: [part("agent", 1_000)],
      tools: [tool("bash", { description: 9_000, tokens: 2_250 }), tool("edit", { description: 40 })],
      total: 1_000,
      toolsTotal: 2_290,
    })
    const long = findings.find((finding) => finding.id === "prompt.tool-description.bash")
    // 9000 characters is 2250 tokens. Reporting the character count as a token
    // count would overstate it fourfold, so this is the assertion that catches it.
    expect(long?.title).toContain("2.3k")
    expect(long?.detail).toContain("input schema")
  })

  test("names only the worst description, so the list stays readable", () => {
    const findings = SessionPromptSize.analyze({
      ...base,
      parts: [part("agent", 1_000)],
      tools: [tool("a", { description: 9_000 }), tool("b", { description: 8_000 })],
      total: 1_000,
      toolsTotal: 1_000,
    })
    expect(findings.filter((finding) => finding.id.startsWith("prompt.tool-description"))).toHaveLength(1)
  })

  test("warns about a prompt that would be empty, which is a bug not a size", () => {
    const findings = SessionPromptSize.analyze({ ...base, parts: [part("agent", null, false)] })
    expect(findings.find((finding) => finding.id === "prompt.empty")?.severity).toBe("warn")
  })

  test("says when no tool definitions resolved at all", () => {
    const findings = SessionPromptSize.analyze({
      ...base,
      parts: [part("agent", 1_000), part("tools", null, false)],
      total: 1_000,
    })
    expect(findings.find((finding) => finding.id === "prompt.no-tools")?.detail).toContain("disabled")
  })

  test("has nothing to say about a small, complete prompt", () => {
    // Tools are 40% of this prompt and it is five hundred tokens in total. A
    // finding about that is arithmetic, not something to act on.
    expect(ids({ ...base, parts: [part("agent", 300), part("tools", 200)], total: 300, toolsTotal: 200 })).toEqual([])
  })
})

describe("sessionPromptSize.formatTokens", () => {
  test("says nothing measured as a dash rather than a zero", () => {
    // Zero and unmeasured are different facts, and collapsing them would make an
    // absent piece look like an empty one.
    expect(SessionPromptSize.formatTokens(null)).toBe("—")
    expect(SessionPromptSize.formatTokens(0)).toBe("0")
  })

  test("scales the way the rest of the harness does", () => {
    expect(SessionPromptSize.formatTokens(999)).toBe("999")
    expect(SessionPromptSize.formatTokens(1_500)).toBe("1.5k")
    expect(SessionPromptSize.formatTokens(2_400_000)).toBe("2.4M")
  })

  test("agrees with the token estimate the rest of the harness sizes text with", () => {
    expect(SessionPromptSize.formatTokens(Token.estimate("x".repeat(4_000)))).toBe("1.0k")
  })
})
