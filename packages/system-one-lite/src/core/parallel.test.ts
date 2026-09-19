/**
 * Tests for parallel prompt system
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  createParallelPrompt,
  buildParallelPromptText,
  buildParallelSchema,
  parseParallelOutput,
  estimateParallelConfidence,
  ISSUE_TRIAGE_PROMPT,
  CODE_REVIEW_PROMPT,
  RELEASE_READINESS_PROMPT,
} from "../core/parallel.js";

// ─── createParallelPrompt ─────────────────────────────────────────────────────

describe("createParallelPrompt", () => {
  it("creates prompt with context and questions", () => {
    const prompt = createParallelPrompt(
      "You are a classifier.",
      [
        { key: "label", question: "What is the label?", schema: z.string() },
        { key: "score", question: "What is the score?", schema: z.number() },
      ],
      "Answer all questions."
    );

    expect(prompt.context).toBe("You are a classifier.");
    expect(prompt.questions).toHaveLength(2);
    expect(prompt.questions[0].key).toBe("label");
    expect(prompt.questions[1].key).toBe("score");
    expect(prompt.instruction).toBe("Answer all questions.");
  });

  it("uses default instruction when none provided", () => {
    const prompt = createParallelPrompt("ctx", [{ key: "a", question: "Q?", schema: z.string() }]);
    expect(prompt.instruction).toBe("Answer all questions below. Output JSON with one field per question.");
  });

  it("preserves description on questions", () => {
    const prompt = createParallelPrompt(
      "ctx",
      [
        {
          key: "x",
          question: "What?",
          schema: z.string(),
          description: "Extra context",
        },
      ]
    );
    expect(prompt.questions[0].description).toBe("Extra context");
  });
});

// ─── buildParallelPromptText ──────────────────────────────────────────────────

describe("buildParallelPromptText", () => {
  it("produces expected prompt format", () => {
    const prompt = createParallelPrompt(
      "Some context here.",
      [
        { key: "category", question: "What type?", schema: z.string() },
        { key: "priority", question: "How urgent?", schema: z.string() },
      ],
      "Please answer."
    );

    const text = buildParallelPromptText(prompt);
    expect(text).toContain("Context:");
    expect(text).toContain("Some context here.");
    expect(text).toContain("Please answer.");
    expect(text).toContain("Question 1 (category): What type?");
    expect(text).toContain("Question 2 (priority): How urgent?");
    expect(text).toContain("Output JSON with keys: category, priority");
  });

  it("includes description when present", () => {
    const prompt = createParallelPrompt(
      "ctx",
      [
        {
          key: "x",
          question: "What?",
          schema: z.string(),
          description: "Details here",
        },
      ]
    );
    const text = buildParallelPromptText(prompt);
    expect(text).toContain("Details: Details here");
  });

  it("handles empty context", () => {
    const prompt = createParallelPrompt(
      "",
      [{ key: "a", question: "Q?", schema: z.string() }]
    );
    const text = buildParallelPromptText(prompt);
    expect(text).not.toContain("Context:");
    expect(text).toContain("Question 1 (a): Q?");
  });

  it("handles no instruction", () => {
    const prompt = createParallelPrompt(
      "ctx",
      [{ key: "a", question: "Q?", schema: z.string() }],
      undefined
    );
    const text = buildParallelPromptText(prompt);
    expect(text).toContain("Answer all questions below.");
  });
});

// ─── buildParallelSchema ──────────────────────────────────────────────────────

describe("buildParallelSchema", () => {
  it("creates correct combined Zod schema", () => {
    const prompt = createParallelPrompt(
      "ctx",
      [
        { key: "label", question: "Label?", schema: z.string() },
        { key: "count", question: "Count?", schema: z.number().int() },
      ]
    );
    const schema = buildParallelSchema(prompt);

    // Should be a ZodObject
    expect(schema._def.typeName).toBe("ZodObject");

    // Should parse valid input
    const parsed = schema.parse({ label: "bug", count: 5 });
    expect(parsed).toEqual({ label: "bug", count: 5 });
  });

  it("validates all fields", () => {
    const prompt = createParallelPrompt(
      "ctx",
      [
        { key: "flag", question: "Flag?", schema: z.boolean() },
        { key: "items", question: "Items?", schema: z.array(z.string()) },
      ]
    );
    const schema = buildParallelSchema(prompt);

    expect(() => schema.parse({ flag: "not_bool", items: [] })).toThrow();
  });
});

// ─── parseParallelOutput ──────────────────────────────────────────────────────

describe("parseParallelOutput", () => {
  it("validates output correctly", () => {
    const prompt = createParallelPrompt(
      "ctx",
      [
        { key: "category", question: "Type?", schema: z.enum(["bug", "feature"]) },
        { key: "priority", question: "Priority?", schema: z.enum(["P0", "P1"]) },
      ]
    );

    const output = JSON.stringify({ category: "bug", priority: "P0" });
    const parsed = parseParallelOutput(prompt, output);
    expect(parsed).toEqual({ category: "bug", priority: "P0" });
  });

  it("throws on invalid output", () => {
    const prompt = createParallelPrompt(
      "ctx",
      [{ key: "category", question: "Type?", schema: z.enum(["bug", "feature"]) }]
    );

    expect(() => parseParallelOutput(prompt, JSON.stringify({ category: "invalid" }))).toThrow();
  });
});

// ─── estimateParallelConfidence ───────────────────────────────────────────────

describe("estimateParallelConfidence", () => {
  it("returns 0.9 for simple enums", () => {
    const prompt = createParallelPrompt(
      "ctx",
      [
        { key: "a", question: "A?", schema: z.enum(["x", "y"]) },
        { key: "b", question: "B?", schema: z.enum(["x", "y"]) },
      ]
    );
    // 2 enums: score = 1 + 1 = 2, length = 2, score <= length * 1 → 0.9
    expect(estimateParallelConfidence(prompt)).toBe(0.9);
  });

  it("returns 0.8 for booleans", () => {
    const prompt = createParallelPrompt(
      "ctx",
      [
        { key: "a", question: "A?", schema: z.boolean() },
        { key: "b", question: "B?", schema: z.boolean() },
      ]
    );
    // 2 booleans: score = 2 + 2 = 4, length = 2, score <= length * 2 → 0.8
    expect(estimateParallelConfidence(prompt)).toBe(0.8);
  });

  it("returns 0.7 for numbers", () => {
    const prompt = createParallelPrompt(
      "ctx",
      [
        { key: "a", question: "A?", schema: z.number() },
        { key: "b", question: "B?", schema: z.number() },
      ]
    );
    // 2 numbers: score = 3 + 3 = 6, length = 2, score <= length * 3 → 0.7
    expect(estimateParallelConfidence(prompt)).toBe(0.7);
  });

  it("returns 0.6 for complex objects", () => {
    const prompt = createParallelPrompt(
      "ctx",
      [
        {
          key: "a",
          question: "A?",
          schema: z.object({ x: z.string(), y: z.number() }),
        },
      ]
    );
    // 1 object with 2 required fields: score = 4, length = 1, score > length * 3 → 0.6
    expect(estimateParallelConfidence(prompt)).toBe(0.6);
  });

  it("returns 0.8 for mixed simple types within threshold", () => {
    const prompt = createParallelPrompt(
      "ctx",
      [
        { key: "a", question: "A?", schema: z.enum(["x"]) },
        { key: "b", question: "B?", schema: z.boolean() },
      ]
    );
    // score = 1 + 2 = 3, length = 2, score <= length * 2 = 4 → 0.8
    expect(estimateParallelConfidence(prompt)).toBe(0.8);
  });
});

// ─── Pre-defined prompts ──────────────────────────────────────────────────────

describe("Pre-defined parallel prompts", () => {
  describe("ISSUE_TRIAGE_PROMPT", () => {
    it("has correct structure", () => {
      expect(ISSUE_TRIAGE_PROMPT.context).toBeTruthy();
      expect(ISSUE_TRIAGE_PROMPT.questions).toHaveLength(5);
      expect(ISSUE_TRIAGE_PROMPT.questions.map(q => q.key)).toEqual([
        "category",
        "priority",
        "area",
        "estimated_hours",
        "needs_design_review",
      ]);
    });

    it("is valid (schema parses correctly)", () => {
      const schema = buildParallelSchema(ISSUE_TRIAGE_PROMPT);
      const valid = {
        category: "bug",
        priority: "P0",
        area: "frontend",
        estimated_hours: 5,
        needs_design_review: true,
      };
      expect(schema.parse(valid)).toEqual(valid);
    });

    it("produces valid prompt text", () => {
      const text = buildParallelPromptText(ISSUE_TRIAGE_PROMPT);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain("Question 1 (category)");
      expect(text).toContain("Question 5 (needs_design_review)");
    });
  });

  describe("CODE_REVIEW_PROMPT", () => {
    it("has correct structure", () => {
      expect(CODE_REVIEW_PROMPT.questions).toHaveLength(3);
      expect(CODE_REVIEW_PROMPT.questions.map(q => q.key)).toEqual([
        "security",
        "correctness",
        "decision",
      ]);
    });

    it("is valid (schema parses correctly)", () => {
      const schema = buildParallelSchema(CODE_REVIEW_PROMPT);
      const valid = {
        security: { has_vuln: false, severity: "none", finding_type: "none" },
        correctness: { has_bug: false, severity: "none", finding_type: "none" },
        decision: { decision: "approve", reason_category: "clean" },
      };
      expect(schema.parse(valid)).toEqual(valid);
    });
  });

  describe("RELEASE_READINESS_PROMPT", () => {
    it("has correct structure", () => {
      expect(RELEASE_READINESS_PROMPT.questions).toHaveLength(4);
      expect(RELEASE_READINESS_PROMPT.questions.map(q => q.key)).toEqual([
        "tests_pass",
        "breaking_changes",
        "migration_needed",
        "confidence",
      ]);
    });

    it("is valid (schema parses correctly)", () => {
      const schema = buildParallelSchema(RELEASE_READINESS_PROMPT);
      const valid = {
        tests_pass: true,
        breaking_changes: false,
        migration_needed: false,
        confidence: 0.95,
      };
      expect(schema.parse(valid)).toEqual(valid);
    });
  });
});
