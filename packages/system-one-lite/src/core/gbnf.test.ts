/**
 * Tests for GBNF grammar generation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import {
  zodToGbnf,
  jsonSchemaToGbnf,
  writeGbnfFile,
  cleanupGbnfFile,
  buildParallelGbnf,
  GBNF,
} from "../core/gbnf.js";
import { tmpdir } from "os";
import { join } from "path";

// ─── zodToGbnf ────────────────────────────────────────────────────────────────

describe("zodToGbnf", () => {
  it("generates grammar for simple enums", () => {
    const schema = z.enum(["bug", "feature", "question"]);
    const grammar = zodToGbnf(schema, "category");
    expect(grammar).toContain('"\\"bug\\""');
    expect(grammar).toContain('"\\"feature\\""');
    expect(grammar).toContain('"\\"question\\""');
    expect(grammar).toContain("category ::=");
  });

  it("generates grammar for booleans", () => {
    const schema = z.boolean();
    const grammar = zodToGbnf(schema, "flag");
    expect(grammar).toContain('boolean ::= ("true" | "false" | "1" | "0")');
  });

  it("generates grammar for numbers", () => {
    const schema = z.number();
    const grammar = zodToGbnf(schema, "count");
    expect(grammar).toContain("number ::=");
  });

  it("generates grammar for constrained numbers", () => {
    const schema = z.number().int().min(0).max(100);
    const grammar = zodToGbnf(schema, "percent");
    expect(grammar).toContain("percent ::=");
  });

  it("generates grammar for objects with kv rules", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const grammar = zodToGbnf(schema, "person");
    expect(grammar).toContain("name-kv");
    expect(grammar).toContain("age-kv");
    expect(grammar).toContain('"\\"name\\""');
    expect(grammar).toContain('"\\"age\\""');
    expect(grammar).toContain("person ::=");
  });

  it("generates grammar with space rule", () => {
    const schema = z.object({
      name: z.string(),
    });
    const grammar = zodToGbnf(schema, "root");
    expect(grammar).toContain('space ::=');
  });

  it("generates grammar for nested objects", () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
        age: z.number(),
      }),
    });
    const grammar = zodToGbnf(schema, "root");
    expect(grammar).toContain("user-name-kv");
    expect(grammar).toContain("user-age-kv");
  });

  it("generates grammar for arrays", () => {
    const schema = z.array(z.string());
    const grammar = zodToGbnf(schema, "items");
    expect(grammar).toContain("items ::=");
    expect(grammar).toContain("[");
    expect(grammar).toContain("]");
  });

  it("generates grammar for optional fields", () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    const grammar = zodToGbnf(schema, "root");
    // Optional fields should still appear in kv rules but not in required list
    expect(grammar).toContain("required-kv");
    expect(grammar).toContain("optional-kv");
  });

  it("generates grammar for enum values with quotes", () => {
    const schema = z.enum(["P0", "P1", "P2"]);
    const grammar = zodToGbnf(schema, "priority");
    // Enum values should be quoted in the grammar
    expect(grammar).toContain('"\\"P0\\""');
    expect(grammar).toContain('"\\"P1\\""');
    expect(grammar).toContain('"\\"P2\\""');
  });
});

// ─── jsonSchemaToGbnf ─────────────────────────────────────────────────────────

describe("jsonSchemaToGbnf", () => {
  it("converts simple JSON schema to GBNF", () => {
    const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
    const grammar = jsonSchemaToGbnf(schema, "root");
    expect(grammar).toContain("root ::=");
    expect(grammar).toContain("name-kv");
  });

  it("handles anyOf (unions)", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "number" }] };
    const grammar = jsonSchemaToGbnf(schema, "value");
    expect(grammar).toContain("value ::=");
    expect(grammar).toContain("|");
  });
});

// ─── writeGbnfFile / cleanupGbnfFile ─────────────────────────────────────────

describe("writeGbnfFile and cleanupGbnfFile", () => {
  it("creates a temp file with grammar content", async () => {
    const grammar = "root ::= [a-z]+";
    const filePath = await writeGbnfFile(grammar);
    expect(filePath).toBeTruthy();
    expect(filePath).toContain("gbnf-");
    expect(filePath).toContain("grammar.gbnf");

    // Verify file exists and has correct content
    const { readFile } = await import("fs/promises");
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe(grammar);

    await cleanupGbnfFile(filePath);
  });

  it("removes temp file after cleanup", async () => {
    const grammar = "test ::= \"hello\"";
    const filePath = await writeGbnfFile(grammar);
    await cleanupGbnfFile(filePath);

    const { existsSync } = await import("fs");
    expect(existsSync(filePath)).toBe(false);
  });

  it("swallows cleanup errors for non-existent files", async () => {
    await expect(cleanupGbnfFile("/nonexistent/path/grammar.gbnf")).resolves.toBeUndefined();
  });

  it("creates unique temp directories for each call", async () => {
    const file1 = await writeGbnfFile("grammar1");
    const file2 = await writeGbnfFile("grammar2");
    expect(file1).not.toBe(file2);
    await cleanupGbnfFile(file1);
    await cleanupGbnfFile(file2);
  });
});

// ─── Grammar cache behavior ───────────────────────────────────────────────────

describe("grammar cache", () => {
  it("returns same grammar string for identical schema", () => {
    const schema = z.object({
      category: z.enum(["bug", "feature"]),
      priority: z.enum(["P0", "P1"]),
    });
    const grammar1 = zodToGbnf(schema);
    const grammar2 = zodToGbnf(schema);
    expect(grammar1).toBe(grammar2);
  });

  it("returns different grammar for different schemas", () => {
    const schema1 = z.object({ a: z.string() });
    const schema2 = z.object({ b: z.number() });
    const grammar1 = zodToGbnf(schema1);
    const grammar2 = zodToGbnf(schema2);
    expect(grammar1).not.toBe(grammar2);
  });
});

// ─── GBNF pre-built constants ─────────────────────────────────────────────────

describe("GBNF constants", () => {
  it("JSON_OBJECT contains expected rules", () => {
    expect(GBNF.JSON_OBJECT).toContain("string ::=");
    expect(GBNF.JSON_OBJECT).toContain("integer ::=");
    expect(GBNF.JSON_OBJECT).toContain("number ::=");
    expect(GBNF.JSON_OBJECT).toContain("boolean ::=");
    expect(GBNF.JSON_OBJECT).toContain("null ::=");
    expect(GBNF.JSON_OBJECT).toContain("object ::=");
    expect(GBNF.JSON_OBJECT).toContain("array ::=");
    expect(GBNF.JSON_OBJECT).toContain("ws ::=");
  });

  it("ISSUE_TRIAGE contains expected rules", () => {
    expect(GBNF.ISSUE_TRIAGE).toContain("category ::=");
    expect(GBNF.ISSUE_TRIAGE).toContain("priority ::=");
    expect(GBNF.ISSUE_TRIAGE).toContain("area ::=");
    expect(GBNF.ISSUE_TRIAGE).toContain("estimated-hours-kv");
    expect(GBNF.ISSUE_TRIAGE).toContain("needs-design-review-kv");
    expect(GBNF.ISSUE_TRIAGE).toContain("root ::=");
  });

  it("CODE_REVIEW contains expected rules", () => {
    expect(GBNF.CODE_REVIEW).toContain("severity ::=");
    expect(GBNF.CODE_REVIEW).toContain("decision ::=");
    expect(GBNF.CODE_REVIEW).toContain("severity-kv");
    expect(GBNF.CODE_REVIEW).toContain("decision-kv");
  });
});

// ─── buildParallelGbnf ────────────────────────────────────────────────────────

describe("buildParallelGbnf", () => {
  it("generates grammar for parallel questions", () => {
    const questions = [
      { key: "category", schema: z.enum(["bug", "feature"]), question: "Type?" },
      { key: "priority", schema: z.enum(["P0", "P1"]), question: "Priority?" },
    ];
    const grammar = buildParallelGbnf(questions);
    expect(grammar).toContain("category ::=");
    expect(grammar).toContain("priority ::=");
    expect(grammar).toContain("root ::=");
  });
});
