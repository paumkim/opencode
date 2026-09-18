import { describe, it, expect } from "vitest";
import { rawFallback, type SingleStepAdapter, type MultiStepAdapter, type QuestionDefinition, type ToolResult, type ToolCard } from "./adapter.js";
import { buildPools } from "../../core/pools.js";

describe("rawFallback", () => {
  it("returns string content as text", () => {
    const result = rawFallback({ content: "hello world" });
    expect(result.text).toBe("hello world");
    expect(result.card.title).toBe("Result");
  });

  it("returns error card when isError is true", () => {
    const result = rawFallback({ content: "oops", isError: true });
    expect(result.card.title).toBe("Error");
  });

  it("returns object content as fields", () => {
    const result = rawFallback({ content: { temp: 72, unit: "F" } });
    expect(result.card.fields).toEqual({ temp: 72, unit: "F" });
    expect(result.card.body).toBeUndefined();
  });
});

describe("adapter types", () => {
  it("SingleStepAdapter requires all fields", () => {
    const adapter: SingleStepAdapter = {
      id: "weather.get_weather",
      server: "weather",
      mcpName: "get_weather",
      label: "Get Weather",
      description: "Get current weather",
      examples: ["What is the weather in Denver?"],
      questions: () => ({}),
      build: () => ({ args: {}, traces: [] }),
      present: () => ({ text: "done", card: {} }),
    };
    expect(adapter.id).toBe("weather.get_weather");
  });

  it("QuestionDefinition supports choice and candidate types", () => {
    const q: QuestionDefinition = {
      key: "city",
      question: "Which city?",
      type: "candidate",
      poolKey: "places",
    };
    expect(q.type).toBe("candidate");
  });

  it("MultiStepAdapter extends SingleStepAdapter with run", () => {
    const adapter: MultiStepAdapter = {
      ...({
        id: "wiki.answer",
        server: "wiki",
        mcpName: "answer",
        label: "Answer",
        description: "Answer from Wikipedia",
        examples: ["How tall is Everest?"],
        questions: () => ({}),
        build: () => ({ args: {}, traces: [] }),
        present: () => ({ text: "done", card: {} }),
      } as SingleStepAdapter),
      run: async () => ({ content: {} }),
    };
    expect(adapter.run).toBeDefined();
  });
});

describe("ToolResult and ToolCard", () => {
  it("ToolResult can carry object content", () => {
    const result: ToolResult = { content: { temp: 72 } };
    expect((result.content as { temp: number }).temp).toBe(72);
  });

  it("ToolCard supports optional fields", () => {
    const card: ToolCard = {
      title: "Done",
      body: "It worked",
      fields: { temp: 72 },
    };
    expect(card.fields?.temp).toBe(72);
  });
});
