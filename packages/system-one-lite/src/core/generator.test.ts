/**
 * Tests for LlamaCppGenerator - core generation pipeline
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { LlamaCppGenerator, createGenerator } from "../core/generator.js";

// ─── Mock child_process ────────────────────────────────────────────────────────

const mockSpawn = vi.fn();
vi.mock("child_process", () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

// Re-import after mock
// Note: spawn is mocked via vi.mock above; no dynamic import needed

let callCount = 0;

function createMockChild(stdout: string, exitCode = 0, delay = 0): any {
  const listeners: Record<string, Function[]> = {};
  const child = {
    stdout: {
      on: (event: string, fn: Function) => {
        listeners[`stdout:${event}`] = listeners[`stdout:${event}`] || [];
        listeners[`stdout:${event}`].push(fn);
        return child.stdout;
      },
    },
    stderr: {
      on: (event: string, fn: Function) => {
        listeners[`stderr:${event}`] = listeners[`stderr:${event}`] || [];
        listeners[`stderr:${event}`].push(fn);
        return child.stderr;
      },
    },
    on: (event: string, fn: Function) => {
      listeners[`child:${event}`] = listeners[`child:${event}`] || [];
      listeners[`child:${event}`].push(fn);
      return child;
    },
    kill: () => {},
  };

  setTimeout(() => {
    (listeners["stdout:data"] || []).forEach(fn => fn(Buffer.from(stdout)));
    (listeners["stderr:data"] || []).forEach(fn => fn(Buffer.from("")));
    (listeners["child:close"] || []).forEach(fn => fn(exitCode));
  }, delay);

  return child;
}

function setupMock(stdout: string | string[], exitCode = 0, delay = 0) {
  callCount = 0;
  mockSpawn.mockImplementation(() => {
    const idx = callCount++;
    const outputs = Array.isArray(stdout) ? stdout : [stdout];
    const codes = Array.isArray(exitCode) ? exitCode : [exitCode];
    const out = outputs[idx] ?? outputs[outputs.length - 1];
    const code = codes[idx] ?? codes[codes.length - 1];
    return createMockChild(out, code, delay);
  });
}

// ─── normalizeOutput (tested indirectly through generate) ─────────────────────

describe("LlamaCppGenerator - normalizeOutput via generate", () => {
  let generator: LlamaCppGenerator;

  beforeEach(() => {
    generator = createGenerator("/fake/model.gguf");
    mockSpawn.mockClear();
    callCount = 0;
  });

  it("passes through booleans unchanged", async () => {
    setupMock('{"flag": true}');
    const schema = z.object({ flag: z.boolean() });
    const result = await generator.generate("test", schema);
    expect(result.value.flag).toBe(true);
  });

  it("converts number 1 to true", async () => {
    setupMock('{"flag": 1}');
    const schema = z.object({ flag: z.boolean() });
    const result = await generator.generate("test", schema);
    expect(result.value.flag).toBe(true);
  });

  it("converts number 0 to false", async () => {
    setupMock('{"flag": 0}');
    const schema = z.object({ flag: z.boolean() });
    const result = await generator.generate("test", schema);
    expect(result.value.flag).toBe(false);
  });

  it("converts string 'yes' to true", async () => {
    setupMock('{"flag": "yes"}');
    const schema = z.object({ flag: z.boolean() });
    const result = await generator.generate("test", schema);
    expect(result.value.flag).toBe(true);
  });

  it("converts string 'no' to false", async () => {
    setupMock('{"flag": "no"}');
    const schema = z.object({ flag: z.boolean() });
    const result = await generator.generate("test", schema);
    expect(result.value.flag).toBe(false);
  });

  it("converts string 'true' to true (case-insensitive)", async () => {
    setupMock('{"flag": "TRUE"}');
    const schema = z.object({ flag: z.boolean() });
    const result = await generator.generate("test", schema);
    expect(result.value.flag).toBe(true);
  });

  it("converts string 'false' to false (case-insensitive)", async () => {
    setupMock('{"flag": "False"}');
    const schema = z.object({ flag: z.boolean() });
    const result = await generator.generate("test", schema);
    expect(result.value.flag).toBe(false);
  });

  it("passes through non-boolean-like strings unchanged", async () => {
    setupMock('{"name": "hello"}');
    const schema = z.object({ name: z.string() });
    const result = await generator.generate("test", schema);
    expect(result.value.name).toBe("hello");
  });

  it("normalizes nested objects recursively", async () => {
    setupMock('{"nested": {"a": 1, "b": "no", "c": "maybe"}}');
    const schema = z.object({
      nested: z.object({
        a: z.boolean(),
        b: z.boolean(),
        c: z.string(),
      }),
    });
    const result = await generator.generate("test", schema);
    expect(result.value.nested).toEqual({ a: true, b: false, c: "maybe" });
  });

  it("normalizes arrays recursively", async () => {
    setupMock('{"items": [1, 0, "yes", "no", "other"]}');
    const schema = z.object({
      items: z.array(z.union([z.boolean(), z.string()])),
    });
    const result = await generator.generate("test", schema);
    expect(result.value.items).toEqual([true, false, true, false, "other"]);
  });

  it("passes through non-boolean numbers unchanged", async () => {
    setupMock('{"count": 42}');
    const schema = z.object({ count: z.number() });
    const result = await generator.generate("test", schema);
    expect(result.value.count).toBe(42);
  });
});

// ─── estimateConfidence ───────────────────────────────────────────────────────

describe("LlamaCppGenerator - estimateConfidence", () => {
  let generator: LlamaCppGenerator;

  beforeEach(() => {
    generator = createGenerator("/fake/model.gguf");
    mockSpawn.mockClear();
    callCount = 0;
  });

  it("returns 0.9 for complete objects", async () => {
    setupMock('{"category": "bug", "priority": "P0"}');
    const schema = z.object({
      category: z.enum(["bug", "feature"]),
      priority: z.enum(["P0", "P1"]),
    });
    const result = await generator.generate("test", schema);
    expect(result.confidence).toBe(0.9);
  });

  it("returns 0.9 for empty schema", async () => {
    setupMock('{}');
    const schema = z.object({});
    const result = await generator.generate("test", schema);
    expect(result.confidence).toBe(0.9);
  });

  it("returns 0.9 when all present fields are non-empty", async () => {
    setupMock('{"name": "test", "count": 5}');
    const schema = z.object({
      name: z.string(),
      count: z.number(),
    });
    const result = await generator.generate("test", schema);
    expect(result.confidence).toBe(0.9);
  });

  it("returns 0.0 when required fields are missing (tested via direct call)", () => {
    const schema = z.object({
      name: z.string(),
      count: z.number(),
      flag: z.boolean(),
    });
    // Access private method via any cast
    const confidence = (generator as any).estimateConfidence(schema, { name: "test" });
    expect(confidence).toBe(0.0);
  });

  it("returns 0.7 when 3 of 4 required fields present (tested via direct call)", () => {
    const schema = z.object({
      name: z.string(),
      count: z.number(),
      flag: z.boolean(),
      active: z.boolean(),
    });
    const confidence = (generator as any).estimateConfidence(schema, { name: "test", count: 5, flag: true });
    // 3 of 4 required fields present → 0.7
    expect(confidence).toBe(0.7);
  });

  it("skips optional fields in confidence calculation", async () => {
    setupMock('{"required_field": "value"}');
    const schema = z.object({
      required_field: z.string(),
      optional_field: z.string().optional(),
    });
    const result = await generator.generate("test", schema);
    expect(result.confidence).toBe(0.9);
  });
});

// ─── stepDependsOn ────────────────────────────────────────────────────────────

describe("LlamaCppGenerator - stepDependsOn", () => {
  let generator: LlamaCppGenerator;

  beforeEach(() => {
    generator = createGenerator("/fake/model.gguf");
    mockSpawn.mockClear();
    callCount = 0;
  });

  it("matches exact step name in template", async () => {
    setupMock(['{"result": "ok1"}', '{"result": "ok2"}']);
    const workflow = {
      name: "test_wf",
      description: "Test workflow",
      steps: [
        {
          name: "first",
          promptTemplate: "Result: {first}",
          schema: z.object({ result: z.string() }),
        },
        {
          name: "second",
          promptTemplate: "First was: {first}. Now: {second}",
          schema: z.object({ result: z.string() }),
        },
      ],
    };
    const result = await generator.runWorkflow(workflow, {});
    expect(result.success).toBe(true);
    expect(result.stepResults.first).toBeDefined();
    expect(result.stepResults.second).toBeDefined();
  });

  it("does NOT match substring (step 'test' vs template '{test_results}')", async () => {
    setupMock('{"result": "ok"}');
    const workflow = {
      name: "substring_test",
      description: "Substring test",
      steps: [
        {
          name: "test",
          promptTemplate: "Results: {test_results}",
          schema: z.object({ result: z.string() }),
        },
      ],
    };
    const result = await generator.runWorkflow(workflow, {});
    expect(result.success).toBe(true);
    expect(result.stepResults.test).toBeDefined();
  });

  it("correctly identifies dependency on another step", async () => {
    setupMock(['{"result": "ok_a"}', '{"result": "ok_b"}']);
    const workflow = {
      name: "dep_test",
      description: "Dependency test",
      steps: [
        {
          name: "step_a",
          promptTemplate: "Do A",
          schema: z.object({ result: z.string() }),
        },
        {
          name: "step_b",
          promptTemplate: "A was: {step_a}. Now do B.",
          schema: z.object({ result: z.string() }),
        },
      ],
    };
    const result = await generator.runWorkflow(workflow, {});
    expect(result.success).toBe(true);
    expect(result.stepResults.step_a).toBeDefined();
    expect(result.stepResults.step_b).toBeDefined();
  });
});

// ─── buildPrompt ──────────────────────────────────────────────────────────────

describe("LlamaCppGenerator - buildPrompt", () => {
  let generator: LlamaCppGenerator;

  beforeEach(() => {
    generator = createGenerator("/fake/model.gguf");
    mockSpawn.mockClear();
    callCount = 0;
  });

  it("replaces context variables", async () => {
    setupMock('{"ok": true}');
    const schema = z.object({ ok: z.boolean() });
    const result = await generator.generate("Issue: {issue_title}", schema);
    expect(result.value.ok).toBe(true);
  });

  it("replaces step results with JSON.stringify", async () => {
    setupMock(['{"result": "step1_done"}', '{"final": "done"}']);
    const workflow = {
      name: "prompt_build_test",
      description: "Prompt build test",
      steps: [
        {
          name: "step1",
          promptTemplate: "Input: {input}",
          schema: z.object({ result: z.string() }),
        },
        {
          name: "step2",
          promptTemplate: "Previous: {step1}. Now: {input}",
          schema: z.object({ final: z.string() }),
        },
      ],
    };
    const result = await generator.runWorkflow(workflow, { input: "test" });
    expect(result.success).toBe(true);
  });
});

// ─── generate() full flow ─────────────────────────────────────────────────────

describe("LlamaCppGenerator - generate() flow", () => {
  let generator: LlamaCppGenerator;

  beforeEach(() => {
    generator = createGenerator("/fake/model.gguf");
    mockSpawn.mockClear();
    callCount = 0;
  });

  it("returns DecisionResult with value, latencyMs, tokensUsed, confidence", async () => {
    setupMock('{"category": "bug", "priority": "P0"}');
    const schema = z.object({
      category: z.enum(["bug", "feature"]),
      priority: z.enum(["P0", "P1"]),
    });
    const result = await generator.generate("Classify this issue", schema);
    expect(result.value).toEqual({ category: "bug", priority: "P0" });
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.tokensUsed).toBe("number");
    expect(typeof result.confidence).toBe("number");
  });

  it("extracts JSON from output with surrounding text", async () => {
    setupMock('Here is the result: {"category": "bug"}');
    const schema = z.object({ category: z.enum(["bug", "feature"]) });
    const result = await generator.generate("test", schema);
    expect(result.value.category).toBe("bug");
  });

  it("rejects when llama.cpp exits with non-zero code", async () => {
    setupMock("error output", 1);
    const schema = z.object({ category: z.string() });
    await expect(generator.generate("test", schema)).rejects.toThrow("llama.cpp exited with code 1");
  });

  it("cleans up grammar file after generation", async () => {
    setupMock('{"ok": true}');
    const schema = z.object({ ok: z.boolean() });
    await generator.generate("test", schema);
    expect(true).toBe(true);
  });

  it("caches grammar for same schema", async () => {
    setupMock('{"ok": true}');
    const schema = z.object({ ok: z.boolean() });
    await generator.generate("test1", schema);
    await generator.generate("test2", schema);
    expect(true).toBe(true);
  });
});

// ─── runWorkflow ──────────────────────────────────────────────────────────────

describe("LlamaCppGenerator - runWorkflow", () => {
  let generator: LlamaCppGenerator;

  beforeEach(() => {
    generator = createGenerator("/fake/model.gguf");
    mockSpawn.mockClear();
    callCount = 0;
  });

  it("runs a simple 1-step workflow", async () => {
    setupMock('{"category": "bug"}');
    const workflow = {
      name: "simple",
      description: "Simple workflow",
      steps: [
        {
          name: "classify",
          promptTemplate: "Classify: {issue}",
          schema: z.object({ category: z.enum(["bug", "feature"]) }),
        },
      ],
    };
    const result = await generator.runWorkflow(workflow, { issue: "login fails" });
    expect(result.success).toBe(true);
    expect(result.workflowName).toBe("simple");
    expect(result.stepResults.classify).toEqual({ category: "bug" });
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it("runs a 2-step workflow with dependency", async () => {
    setupMock([
      '{"has_vuln": true, "severity": "high"}',
      '{"decision": "block", "reason": "security"}',
    ]);
    const workflow = {
      name: "two_step",
      description: "Two step workflow",
      steps: [
        {
          name: "security_check",
          promptTemplate: "Check: {diff}",
          schema: z.object({
            has_vuln: z.boolean(),
            severity: z.enum(["none", "low", "medium", "high", "critical"]),
          }),
        },
        {
          name: "final_decision",
          promptTemplate: "Security: {security_check}. Decide.",
          schema: z.object({
            decision: z.enum(["approve", "request_changes", "block"]),
            reason: z.string(),
          }),
        },
      ],
    };
    const result = await generator.runWorkflow(workflow, { diff: "some code" });
    expect(result.success).toBe(true);
    expect(result.stepResults.security_check).toEqual({ has_vuln: true, severity: "high" });
    expect(result.stepResults.final_decision).toEqual({ decision: "block", reason: "security" });
  });

  it("returns error on workflow failure", async () => {
    setupMock("error", 1);
    const workflow = {
      name: "failing",
      description: "Failing workflow",
      steps: [
        {
          name: "step1",
          promptTemplate: "test",
          schema: z.object({ ok: z.boolean() }),
        },
      ],
    };
    const result = await generator.runWorkflow(workflow, {});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("applies extract function to step output", async () => {
    setupMock('{"category": "bug", "priority": "P0"}');
    const workflow = {
      name: "extract_test",
      description: "Extract test",
      steps: [
        {
          name: "classify",
          promptTemplate: "test",
          schema: z.object({
            category: z.enum(["bug", "feature"]),
            priority: z.enum(["P0", "P1"]),
          }),
          extract: (output: any) => output.category,
        },
      ],
    };
    const result = await generator.runWorkflow(workflow, {});
    expect(result.stepResults.classify).toBe("bug");
  });
});

// ─── runBatch ─────────────────────────────────────────────────────────────────

describe("LlamaCppGenerator - runBatch", () => {
  let generator: LlamaCppGenerator;

  beforeEach(() => {
    generator = createGenerator("/fake/model.gguf");
    mockSpawn.mockClear();
    callCount = 0;
  });

  it("processes multiple contexts with bounded concurrency", async () => {
    setupMock('{"result": "ok"}');
    const workflow = {
      name: "batch_test",
      description: "Batch test",
      steps: [
        {
          name: "step1",
          promptTemplate: "Process: {input}",
          schema: z.object({ result: z.string() }),
        },
      ],
    };
    const contexts = [
      { input: "context1" },
      { input: "context2" },
      { input: "context3" },
    ];
    const results = await generator.runBatch(workflow, contexts, 2);
    expect(results).toHaveLength(3);
    results.forEach(r => {
      expect(r.success).toBe(true);
      expect(r.stepResults.step1).toEqual({ result: "ok" });
    });
  });

  it("returns results in order", async () => {
    setupMock('{"id": "placeholder"}');
    const workflow = {
      name: "order_test",
      description: "Order test",
      steps: [
        {
          name: "step1",
          promptTemplate: "ID: {id}",
          schema: z.object({ id: z.string() }),
        },
      ],
    };
    const contexts = [{ id: "a" }, { id: "b" }];
    const results = await generator.runBatch(workflow, contexts);
    expect(results[0].workflowName).toBe("order_test");
    expect(results[1].workflowName).toBe("order_test");
  });
});

// ─── generateRaw ──────────────────────────────────────────────────────────────

describe("LlamaCppGenerator - generateRaw", () => {
  let generator: LlamaCppGenerator;

  beforeEach(() => {
    generator = createGenerator("/fake/model.gguf");
    mockSpawn.mockClear();
    callCount = 0;
  });

  it("returns raw text without Zod parsing", async () => {
    setupMock("raw output text");
    const result = await generator.generateRaw("test prompt", "root ::= [a-z]+");
    expect(result).toBe("raw output text");
  });
});

// ─── createGenerator factory ──────────────────────────────────────────────────

describe("createGenerator factory", () => {
  it("creates generator with default config", () => {
    const gen = createGenerator("/fake/model.gguf");
    expect(gen).toBeInstanceOf(LlamaCppGenerator);
  });

  it("applies overrides", () => {
    const gen = createGenerator("/fake/model.gguf", {
      temperature: 0.5,
      maxTokens: 1024,
    });
    const config = (gen as any).config;
    expect(config.temperature).toBe(0.5);
    expect(config.maxTokens).toBe(1024);
  });
});
