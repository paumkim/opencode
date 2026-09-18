import { describe, it, expect } from "vitest";
import { generateTraceId, type TurnTrace, type ArgTrace, type QuestionTrace, type ToolCallTrace } from "../core/trace.js";

describe("generateTraceId", () => {
  it("returns an 8-character hex string", () => {
    const id = generateTraceId();
    expect(id).toHaveLength(8);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns unique ids across multiple calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
    expect(ids.size).toBe(100);
  });
});

describe("trace types", () => {
  it("TurnTrace accepts all required fields", () => {
    const trace: TurnTrace = {
      id: "abc12345",
      originalMessage: "test",
      preprocessedMessage: "test",
      pools: {
        text: "test",
        spans: [],
        numbers: [],
        dates: [],
        places: [],
        people: [],
        recentResults: [],
        message: "test",
      },
      jevCalls: [],
      latencyMs: 10,
    };
    expect(trace.id).toBe("abc12345");
  });

  it("ArgTrace accepts source field", () => {
    const arg: ArgTrace = {
      key: "city",
      value: "Denver",
      source: "jev",
      fromPool: "places",
    };
    expect(arg.source).toBe("jev");
  });

  it("QuestionTrace accepts probabilities", () => {
    const q: QuestionTrace = {
      key: "tool",
      question: "Which tool?",
      options: { weather: "Get weather" },
      answer: "weather",
      probabilities: { weather: 0.9, search: 0.1 },
    };
    expect(q.probabilities?.weather).toBeCloseTo(0.9);
  });

  it("ToolCallTrace records args and result", () => {
    const tc: ToolCallTrace = {
      serverId: "weather",
      toolName: "get_weather",
      args: [{ key: "city", value: "Denver", source: "jev" }],
      result: { temp: 72 },
    };
    expect(tc.args[0].value).toBe("Denver");
  });
});
