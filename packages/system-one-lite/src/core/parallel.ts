/**
 * Parallel Prompt System - Multiple questions answered in single model call
 * Uses combined GBNF grammar for all questions at once
 */

import { z } from "zod";
import type { Question, ParallelPrompt } from "./types.js";
import { buildParallelGbnf } from "./gbnf.js";

/**
 * Create a parallel prompt from question definitions
 */
export function createParallelPrompt(
  context: string,
  questions: Array<{
    key: string;
    question: string;
    schema: z.ZodSchema;
    description?: string;
  }>,
  instruction?: string
): ParallelPrompt {
  return {
    context,
    questions: questions.map(q => ({
      key: q.key,
      question: q.question,
      schema: q.schema,
      description: q.description,
    })),
    instruction: instruction ?? "Answer all questions below. Output JSON with one field per question.",
  };
}

/**
 * Build the full prompt text for a parallel prompt
 */
export function buildParallelPromptText(prompt: ParallelPrompt): string {
  const parts: string[] = [];

  if (prompt.context) {
    parts.push(`Context:\n${prompt.context}\n`);
  }

  parts.push(prompt.instruction ?? "Answer all questions below.");
  parts.push("");

  for (let i = 0; i < prompt.questions.length; i++) {
    const q = prompt.questions[i];
    parts.push(`Question ${i + 1} (${q.key}): ${q.question}`);
    if (q.description) {
      parts.push(`  Details: ${q.description}`);
    }
    parts.push("");
  }

  parts.push(`Output JSON with keys: ${prompt.questions.map(q => q.key).join(", ")}`);
  return parts.join("\n");
}

/**
 * Build combined Zod schema for all questions
 */
export function buildParallelSchema(prompt: ParallelPrompt): z.ZodObject<any> {
  const shape: Record<string, z.ZodSchema> = {};
  for (const q of prompt.questions) {
    shape[q.key] = q.schema;
  }
  return z.object(shape);
}

/**
 * Pre-defined parallel prompts for common workflows
 */

// Issue triage - 5 questions in one call
export const ISSUE_TRIAGE_PROMPT = createParallelPrompt(
  "You are triaging a GitHub issue for a TypeScript project.",
  [
    {
      key: "category",
      question: "What type of issue is this?",
      schema: z.enum(["bug", "feature", "question", "docs", "refactor"]),
    },
    {
      key: "priority",
      question: "What is the priority?",
      schema: z.enum(["P0", "P1", "P2", "P3"]),
    },
    {
      key: "area",
      question: "Which code area is affected?",
      schema: z.enum(["frontend", "backend", "cli", "docs", "infra", "unknown"]),
    },
    {
      key: "estimated_hours",
      question: "Estimated hours to fix?",
      schema: z.number().int().min(0).max(100),
    },
    {
      key: "needs_design_review",
      question: "Does this need design review?",
      schema: z.boolean(),
    },
  ]
);

// Code review - 3 questions in one call
export const CODE_REVIEW_PROMPT = createParallelPrompt(
  "You are reviewing a code change for correctness and security.",
  [
    {
      key: "security",
      question: "Are there security vulnerabilities?",
      schema: z.object({
        has_vuln: z.boolean(),
        severity: z.enum(["none", "low", "medium", "high", "critical"]),
        details: z.string(),
      }),
    },
    {
      key: "correctness",
      question: "Are there correctness bugs?",
      schema: z.object({
        has_bug: z.boolean(),
        severity: z.enum(["none", "low", "medium", "high"]),
        details: z.string(),
      }),
    },
    {
      key: "decision",
      question: "Final review decision?",
      schema: z.object({
        decision: z.enum(["approve", "request_changes", "block"]),
        reason: z.string(),
      }),
    },
  ]
);

// Release readiness - 4 questions
export const RELEASE_READINESS_PROMPT = createParallelPrompt(
  "You are evaluating if a release candidate is ready to ship.",
  [
    {
      key: "tests_pass",
      question: "Do all tests pass?",
      schema: z.boolean(),
    },
    {
      key: "breaking_changes",
      question: "Are there breaking changes?",
      schema: z.boolean(),
    },
    {
      key: "migration_needed",
      question: "Is migration guide needed?",
      schema: z.boolean(),
    },
    {
      key: "confidence",
      question: "Confidence in release readiness (0-1)?",
      schema: z.number().min(0).max(1),
    },
  ]
);

/**
 * Generate GBNF grammar for a parallel prompt
 */
export function getParallelGbnf(prompt: ParallelPrompt): string {
  return buildParallelGbnf(prompt.questions);
}

/**
 * Parse and validate parallel prompt output
 */
export function parseParallelOutput<T extends ParallelPrompt>(
  prompt: T,
  output: string
): z.infer<ReturnType<typeof buildParallelSchema>> {
  const schema = buildParallelSchema(prompt);
  return schema.parse(JSON.parse(output));
}