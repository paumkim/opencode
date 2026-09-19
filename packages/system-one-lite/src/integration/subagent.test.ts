/**
 * Tests for subagent integration
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import {
  createSystemOneAgent,
  createSystemOneAgentFromModel,
  SystemOneSubagent,
  ModelSelector,
  OPENCODE_AGENT_MANIFEST,
  type ModelCapabilities,
  type SystemOneConfig,
} from "../integration/subagent.js";
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

// ─── Mock preprocess to avoid cspell-lib issues ───────────────────────────────

vi.mock("../core/preprocess.js", () => ({
  correctSpelling: vi.fn(async (text: string) => ({ text, fixes: [], suggestions: [] })),
  resolveFollowUp: vi.fn((text: string) => ({ text, fixes: [], suggestions: [] })),
}));

// ─── createSystemOneAgent ─────────────────────────────────────────────────────

describe("createSystemOneAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes with correct workflows and parallel prompts", () => {
    const agent = createSystemOneAgent({ modelPath: "/fake/model.gguf" });
    expect(agent).toBeInstanceOf(SystemOneSubagent);
    expect(agent.getWorkflows()).toEqual([
      "issue_triage",
      "code_review",
      "release_readiness",
    ]);
    expect(agent.getParallelPrompts()).toEqual([
      "issue_triage",
      "code_review",
      "release_readiness",
    ]);
  });

  it("registers custom workflows", () => {
    const agent = createSystemOneAgent({ modelPath: "/fake/model.gguf" });
    agent.registerWorkflow("custom", {
      name: "custom",
      description: "Custom workflow",
      steps: [
        {
          name: "step1",
          promptTemplate: "test",
          schema: z.object({ ok: z.boolean() }),
        },
      ],
    });
    expect(agent.getWorkflows()).toContain("custom");
  });

  it("registers custom parallel prompts", () => {
    const agent = createSystemOneAgent({ modelPath: "/fake/model.gguf" });
    const customPrompt = createParallelPrompt(
      "ctx",
      [{ key: "x", question: "X?", schema: z.string() }]
    );
    agent.registerParallelPrompt("custom", customPrompt);
    expect(agent.getParallelPrompts()).toContain("custom");
  });
});

// ─── decide ───────────────────────────────────────────────────────────────────

describe("SystemOneSubagent - decide", () => {
  let agent: SystemOneSubagent;

  beforeEach(() => {
    agent = createSystemOneAgent({ modelPath: "/fake/model.gguf" });
    mockSpawn.mockClear();
  });

  it("uses parallel prompt when available", async () => {
    setupMock('{"category": "bug", "priority": "P0", "area": "frontend", "estimated_hours": 2, "needs_design_review": false}');
    const result = await agent.decide("issue_triage", {
      context: "Issue: login fails",
    });
    expect(result.success).toBe(true);
    expect(result.stepResults.category).toBe("bug");
    expect(result.workflowName).toBe("issue_triage");
  });

  it("falls back to workflow runner when no parallel prompt", async () => {
    setupMock('{"ok": true}');
    agent.registerWorkflow("no_parallel", {
      name: "no_parallel",
      description: "No parallel prompt",
      steps: [
        {
          name: "step1",
          promptTemplate: "test",
          schema: z.object({ ok: z.boolean() }),
        },
      ],
    });
    const result = await agent.decide("no_parallel", {});
    expect(result.success).toBe(true);
  });

  it("returns error result on failure", async () => {
    setupMock("error", 1);
    const result = await agent.decide("issue_triage", { context: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("throws for unknown workflow", async () => {
    await expect(agent.decide("nonexistent", {})).rejects.toThrow(
      "Unknown workflow: nonexistent"
    );
  });
});

// ─── decideParallel ───────────────────────────────────────────────────────────

describe("SystemOneSubagent - decideParallel", () => {
  let agent: SystemOneSubagent;

  beforeEach(() => {
    agent = createSystemOneAgent({ modelPath: "/fake/model.gguf" });
    mockSpawn.mockClear();
  });

  it("runs parallel prompt and returns parsed output", async () => {
    setupMock('{"category": "bug", "priority": "P0", "area": "frontend", "estimated_hours": 2, "needs_design_review": false}');
    const result = await agent.decideParallel("issue_triage", "Some context");
    expect(result).toEqual({ category: "bug", priority: "P0", area: "frontend", estimated_hours: 2, needs_design_review: false });
  });

  it("throws for unknown parallel prompt", async () => {
    await expect(agent.decideParallel("nonexistent")).rejects.toThrow(
      "Unknown parallel prompt: nonexistent"
    );
  });
});

// ─── Convenience methods ──────────────────────────────────────────────────────

describe("SystemOneSubagent - convenience methods", () => {
  let agent: SystemOneSubagent;

  beforeEach(() => {
    agent = createSystemOneAgent({ modelPath: "/fake/model.gguf" });
    mockSpawn.mockClear();
  });

  it("classifyIssue calls decide with issue_triage", async () => {
    setupMock('{"category": "bug", "priority": "P0", "area": "frontend", "estimated_hours": 2, "needs_design_review": false}');
    const result = await agent.classifyIssue("Login fails", "500 error on Safari");
    expect(result.workflowName).toBe("issue_triage");
    expect(result.success).toBe(true);
  });

  it("reviewCode calls decide with code_review", async () => {
    setupMock('{"security": {"has_vuln": false, "severity": "none", "finding_type": "none"}, "correctness": {"has_bug": false, "severity": "none", "finding_type": "none"}, "decision": {"decision": "approve", "reason_category": "clean"}}');
    const result = await agent.reviewCode("diff content");
    expect(result.workflowName).toBe("code_review");
    expect(result.success).toBe(true);
  });

  it("checkRelease calls decide with release_readiness", async () => {
    setupMock('{"tests_pass": true, "breaking_changes": false, "migration_needed": false, "confidence": 0.95}');
    const result = await agent.checkRelease("v1.0", "Initial release", "All pass");
    expect(result.workflowName).toBe("release_readiness");
    expect(result.success).toBe(true);
  });
});

// ─── ModelSelector ────────────────────────────────────────────────────────────

describe("ModelSelector", () => {
  it("selects fast model for simple workflow", () => {
    const models: ModelCapabilities[] = [
      {
        path: "./models/qwen2.5-3b.gguf",
        name: "qwen2.5-3b",
        sizeGB: 2.4,
        vramGB: 6,
        speed: "fast",
        accuracy: "medium",
        strengths: ["enums", "booleans"],
      },
      {
        path: "./models/llama-3.1-8b.gguf",
        name: "llama-3.1-8b",
        sizeGB: 4.7,
        vramGB: 8,
        speed: "medium",
        accuracy: "high",
        strengths: ["complex reasoning"],
      },
    ];
    const selector = new ModelSelector(models);
    const simpleWorkflow = {
      name: "simple",
      description: "Simple",
      steps: [
        {
          name: "s1",
          promptTemplate: "test",
          schema: z.object({ a: z.enum(["x", "y"]) }),
        },
      ],
    };
    const selected = selector.select(simpleWorkflow);
    expect(selected.speed).toBe("fast");
  });

  it("selects accurate model for complex workflow", () => {
    const models: ModelCapabilities[] = [
      {
        path: "./models/qwen2.5-3b.gguf",
        name: "qwen2.5-3b",
        sizeGB: 2.4,
        vramGB: 6,
        speed: "fast",
        accuracy: "medium",
        strengths: ["enums"],
      },
      {
        path: "./models/llama-3.1-8b.gguf",
        name: "llama-3.1-8b",
        sizeGB: 4.7,
        vramGB: 8,
        speed: "medium",
        accuracy: "high",
        strengths: ["complex reasoning"],
      },
    ];
    const selector = new ModelSelector(models);
    const complexWorkflow = {
      name: "complex",
      description: "Complex",
      steps: [
        {
          name: "s1",
          promptTemplate: "Analyze: {input}",
          schema: z.object({
            summary: z.string(),
            details: z.object({
              points: z.array(z.string()),
              score: z.number(),
            }),
          }),
        },
        {
          name: "s2",
          promptTemplate: "Based on {s1}, decide",
          schema: z.object({
            decision: z.string(),
            reasoning: z.string(),
          }),
        },
      ],
    };
    const selected = selector.select(complexWorkflow);
    expect(selected.accuracy).toBe("high");
  });

  it("returns all registered models", () => {
    const selector = new ModelSelector();
    const models = selector.getModels();
    expect(models.length).toBeGreaterThanOrEqual(2);
  });

  it("registers custom models", () => {
    const selector = new ModelSelector();
    selector.registerModel({
      path: "./models/custom.gguf",
      name: "custom-model",
      sizeGB: 3.0,
      vramGB: 6,
      speed: "fast",
      accuracy: "high",
      strengths: ["custom"],
    });
    const models = selector.getModels();
    expect(models.some(m => m.name === "custom-model")).toBe(true);
  });
});

// ─── OPENCODE_AGENT_MANIFEST ──────────────────────────────────────────────────

describe("OPENCODE_AGENT_MANIFEST", () => {
  it("has correct structure", () => {
    expect(OPENCODE_AGENT_MANIFEST.name).toBe("system-one");
    expect(OPENCODE_AGENT_MANIFEST.type).toBe("subagent");
    expect(OPENCODE_AGENT_MANIFEST.description).toBeTruthy();
    expect(OPENCODE_AGENT_MANIFEST.configSchema).toBeDefined();
    expect(OPENCODE_AGENT_MANIFEST.tools).toBeDefined();
  });

  it("has correct tools list", () => {
    expect(OPENCODE_AGENT_MANIFEST.tools).toEqual([
      "decide",
      "decideParallel",
      "classifyIssue",
      "reviewCode",
      "checkRelease",
    ]);
  });

  it("configSchema validates correctly", () => {
    const validConfig = {
      backend: "llama.cpp",
      ctxSize: 4096,
      ngl: 999,
      temperature: 0.0,
      maxTokens: 512,
      binaryPath: "llama-completion",
      defaultWorkflow: "issue_triage",
      autoSelectModel: false,
    };
    expect(() => OPENCODE_AGENT_MANIFEST.configSchema.parse(validConfig)).not.toThrow();
  });

  it("configSchema rejects invalid backend", () => {
    expect(() =>
      OPENCODE_AGENT_MANIFEST.configSchema.parse({ backend: "invalid" })
    ).toThrow();
  });
});

// ─── createSystemOneAgentFromModel ────────────────────────────────────────────

describe("createSystemOneAgentFromModel", () => {
  it("creates local agent for non-kilo model", () => {
    const agent = createSystemOneAgentFromModel("./models/qwen2.5-3b.gguf");
    expect(agent).toBeInstanceOf(SystemOneSubagent);
  });

  it("creates CLI agent for kilo/ model", () => {
    const agent = createSystemOneAgentFromModel("kilo/muse-spark");
    expect(agent).toBeInstanceOf(SystemOneSubagent);
  });
});

// ─── Full flow with mocked generator ─────────────────────────────────────────

describe("SystemOneSubagent - full flow with mocked generator", () => {
  let agent: SystemOneSubagent;
  let mockGenerate: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerate = vi.fn().mockResolvedValue({
      value: { category: "bug", priority: "P0", area: "frontend", estimated_hours: 2, needs_design_review: false },
      latencyMs: 50,
      tokensUsed: 30,
      confidence: 0.9,
    });

    // Create agent with mocked generator
    const config: SystemOneConfig = {
      modelPath: "/fake/model.gguf",
    };
    agent = createSystemOneAgent(config);

    // Replace the generator's generate method
    const generator = (agent as any).generator;
    if (generator && generator.generate) {
      generator.generate = mockGenerate;
    }
  });

  it("executeTurn returns result and trace", async () => {
    const { result, trace } = await agent.executeTurn("Login fails with 500");
    expect(result.workflowName).toBe("issue_triage");
    expect(result.success).toBe(true);
    expect(trace.id).toBeDefined();
    expect(trace.originalMessage).toBe("Login fails with 500");
    expect(typeof trace.latencyMs).toBe("number");
  });

  it("executeTurn handles errors gracefully", async () => {
    mockGenerate.mockRejectedValue(new Error("Model error"));
    const { result, trace } = await agent.executeTurn("test message");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Model error");
    expect(trace.error).toBe("Model error");
  });

  it("confidenceGate returns options when confidence < 0.7", () => {
    const gated = (agent as any).confidenceGate("value", 0.5);
    expect(gated).toHaveProperty("options");
    expect(gated.options).toEqual(["value"]);
  });

  it("confidenceGate returns value when confidence >= 0.7", () => {
    const gated = (agent as any).confidenceGate("value", 0.9);
    expect(gated).toHaveProperty("value");
    expect(gated.value).toBe("value");
  });
});
