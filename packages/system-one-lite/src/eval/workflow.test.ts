/**
 * Tests for evaluation harness
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import {
  WorkflowRunner,
  computeAgreement,
  computeMetrics,
  loadContexts,
  saveResults,
  ISSUE_TRIAGE_WORKFLOW,
  CODE_REVIEW_WORKFLOW,
} from "../eval/workflow.js";
import { LlamaCppGenerator, createGenerator } from "../core/generator.js";
import { join } from "path";
import { tmpdir } from "os";
import { writeFileSync, rmSync, existsSync } from "fs";

// ─── Mock child_process ────────────────────────────────────────────────────────

const mockSpawn = vi.fn();
vi.mock("child_process", () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

// Note: spawn is mocked via vi.mock above; no dynamic import needed

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

function setupMock(stdout: string, exitCode = 0, delay = 0) {
  mockSpawn.mockImplementation(() => createMockChild(stdout, exitCode, delay));
}

function createMockGenerator(): LlamaCppGenerator {
  return createGenerator("/fake/model.gguf");
}

// ─── loadContexts ─────────────────────────────────────────────────────────────

describe("loadContexts", () => {
  const testDir = join(tmpdir(), "system-one-lite-eval-test");

  beforeEach(() => {
    const { mkdirSync } = require("fs");
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    const { rmSync } = require("fs");
    rmSync(testDir, { recursive: true, force: true });
  });

  it("loads contexts from JSONL file", async () => {
    const filePath = join(testDir, "contexts.jsonl");
    const lines = [
      JSON.stringify({ issue: "bug 1" }),
      JSON.stringify({ issue: "bug 2" }),
    ];
    writeFileSync(filePath, lines.join("\n") + "\n");

    const contexts = await loadContexts(filePath);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toEqual({ issue: "bug 1" });
    expect(contexts[1]).toEqual({ issue: "bug 2" });
  });

  it("handles single context", async () => {
    const filePath = join(testDir, "single.jsonl");
    writeFileSync(filePath, JSON.stringify({ issue: "only one" }) + "\n");

    const contexts = await loadContexts(filePath);
    expect(contexts).toHaveLength(1);
  });
});

// ─── saveResults ──────────────────────────────────────────────────────────────

describe("saveResults", () => {
  const testDir = join(tmpdir(), "system-one-lite-save-test");

  beforeEach(() => {
    const { mkdirSync } = require("fs");
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    const { rmSync } = require("fs");
    rmSync(testDir, { recursive: true, force: true });
  });

  it("saves results to JSONL file", async () => {
    const filePath = join(testDir, "results.jsonl");
    const results = [
      {
        workflowName: "test",
        stepResults: { step1: "ok" },
        totalLatencyMs: 100,
        totalTokens: 50,
        success: true,
      },
      {
        workflowName: "test",
        stepResults: { step1: "fail" },
        totalLatencyMs: 200,
        totalTokens: 80,
        success: false,
        error: "something went wrong",
      },
    ];

    await saveResults(results, filePath);

    const { readFileSync } = require("fs");
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).success).toBe(true);
    expect(JSON.parse(lines[1]).success).toBe(false);
    expect(JSON.parse(lines[1]).error).toBe("something went wrong");
  });
});

// ─── computeAgreement ─────────────────────────────────────────────────────────

describe("computeAgreement", () => {
  it("returns 1.0 for matching results", () => {
    const results = [
      {
        workflowName: "wf",
        stepResults: { a: 1, b: "x" },
        totalLatencyMs: 100,
        totalTokens: 50,
        success: true,
      },
    ];
    const referenceResults = [
      {
        workflowName: "wf",
        stepResults: { a: 1, b: "x" },
        totalLatencyMs: 200,
        totalTokens: 60,
        success: true,
      },
    ];

    expect(computeAgreement(results, referenceResults)).toBe(1.0);
  });

  it("returns 0.0 for non-matching results", () => {
    const results = [
      {
        workflowName: "wf",
        stepResults: { a: 1 },
        totalLatencyMs: 100,
        totalTokens: 50,
        success: true,
      },
    ];
    const referenceResults = [
      {
        workflowName: "wf",
        stepResults: { a: 2 },
        totalLatencyMs: 200,
        totalTokens: 60,
        success: true,
      },
    ];

    expect(computeAgreement(results, referenceResults)).toBe(0.0);
  });

  it("only counts agreement when both succeed", () => {
    const results = [
      {
        workflowName: "wf",
        stepResults: { a: 1 },
        totalLatencyMs: 100,
        totalTokens: 50,
        success: true,
      },
      {
        workflowName: "wf",
        stepResults: {},
        totalLatencyMs: 100,
        totalTokens: 0,
        success: false,
      },
    ];
    const referenceResults = [
      {
        workflowName: "wf",
        stepResults: { a: 1 },
        totalLatencyMs: 200,
        totalTokens: 60,
        success: true,
      },
      {
        workflowName: "wf",
        stepResults: {},
        totalLatencyMs: 200,
        totalTokens: 0,
        success: true,
      },
    ];

    // Only the first pair matches (both succeed and same stepResults)
    // Second pair: results[1] failed → not counted
    expect(computeAgreement(results, referenceResults)).toBe(0.5);
  });

  it("throws on mismatched result counts", () => {
    expect(() =>
      computeAgreement(
        [{ workflowName: "wf", stepResults: {}, totalLatencyMs: 0, totalTokens: 0, success: true }],
        []
      )
    ).toThrow("Mismatched result counts");
  });
});

// ─── computeMetrics ───────────────────────────────────────────────────────────

describe("computeMetrics", () => {
  it("calculates success rate, latency, tokens correctly", () => {
    const results = [
      {
        workflowName: "test",
        stepResults: {},
        totalLatencyMs: 100,
        totalTokens: 50,
        success: true,
      },
      {
        workflowName: "test",
        stepResults: {},
        totalLatencyMs: 300,
        totalTokens: 150,
        success: true,
      },
      {
        workflowName: "test",
        stepResults: {},
        totalLatencyMs: 200,
        totalTokens: 0,
        success: false,
      },
    ];

    const metrics = computeMetrics("test", results);
    expect(metrics.workflowName).toBe("test");
    expect(metrics.nSamples).toBe(3);
    expect(metrics.successRate).toBeCloseTo(2 / 3, 5);
    expect(metrics.avgLatencyMs).toBeCloseTo(200, 5);
    expect(metrics.avgTokens).toBeCloseTo(200 / 3, 5);
  });

  it("includes agreement rate when reference results provided", () => {
    const results = [
      {
        workflowName: "wf",
        stepResults: { a: 1 },
        totalLatencyMs: 100,
        totalTokens: 50,
        success: true,
      },
    ];
    const referenceResults = [
      {
        workflowName: "wf",
        stepResults: { a: 1 },
        totalLatencyMs: 200,
        totalTokens: 60,
        success: true,
      },
    ];

    const metrics = computeMetrics("wf", results, referenceResults);
    expect(metrics.agreementRate).toBe(1.0);
  });

  it("does not include agreement rate when no reference", () => {
    const results = [
      {
        workflowName: "wf",
        stepResults: {},
        totalLatencyMs: 100,
        totalTokens: 50,
        success: true,
      },
    ];

    const metrics = computeMetrics("wf", results);
    expect(metrics.agreementRate).toBeUndefined();
  });
});

// ─── WorkflowRunner ───────────────────────────────────────────────────────────

describe("WorkflowRunner", () => {
  let generator: LlamaCppGenerator;
  let runner: WorkflowRunner;

  beforeEach(() => {
    generator = createMockGenerator();
    runner = new WorkflowRunner(generator);
    mockSpawn.mockClear();
  });

  it("runs a workflow and returns WorkflowResult", async () => {
    setupMock('{"category": "bug", "priority": "P0", "area": "frontend", "estimated_hours": 2, "needs_design_review": false}');
    const result = await runner.run(ISSUE_TRIAGE_WORKFLOW, {
      context: "Issue: login fails",
      issue_title: "Login fails",
      issue_body: "Users report 500",
    });
    expect(result.workflowName).toBe("issue_triage");
    expect(result.success).toBe(true);
    expect(result.stepResults.classify).toBeDefined();
  });

  it("runs batch with bounded concurrency", async () => {
    setupMock('{"category": "bug", "priority": "P0", "area": "frontend", "estimated_hours": 2, "needs_design_review": false}');
    const contexts = [
      { context: "Issue 1", issue_title: "A", issue_body: "" },
      { context: "Issue 2", issue_title: "B", issue_body: "" },
    ];
    const results = await runner.runBatch(ISSUE_TRIAGE_WORKFLOW, contexts, 2);
    expect(results).toHaveLength(2);
    results.forEach(r => expect(r.success).toBe(true));
  });

  it("throws when no reference generator configured", async () => {
    const noRefRunner = new WorkflowRunner(generator);
    await expect(
      noRefRunner.runWithReference(ISSUE_TRIAGE_WORKFLOW, [{ context: "test" }])
    ).rejects.toThrow("No reference generator configured");
  });
});

// ─── Pre-defined workflows ────────────────────────────────────────────────────

describe("Pre-defined workflows", () => {
  it("ISSUE_TRIAGE_WORKFLOW has correct structure", () => {
    expect(ISSUE_TRIAGE_WORKFLOW.name).toBe("issue_triage");
    expect(ISSUE_TRIAGE_WORKFLOW.steps).toHaveLength(1);
    expect(ISSUE_TRIAGE_WORKFLOW.steps[0].name).toBe("classify");
    expect(ISSUE_TRIAGE_WORKFLOW.steps[0].schema).toBeDefined();
  });

  it("CODE_REVIEW_WORKFLOW has correct structure", () => {
    expect(CODE_REVIEW_WORKFLOW.name).toBe("code_review");
    expect(CODE_REVIEW_WORKFLOW.steps).toHaveLength(3);
    expect(CODE_REVIEW_WORKFLOW.steps.map(s => s.name)).toEqual([
      "security_check",
      "correctness_check",
      "final_decision",
    ]);
  });
});
