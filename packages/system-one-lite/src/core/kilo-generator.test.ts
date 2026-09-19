/**
 * Unit tests for KiloGenerator
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import {
  KiloGenerator,
  createKiloGenerator,
  KILO_BASE_URL,
  resolveKiloApiKey,
  zodToJsonSchema,
} from "./kilo-generator.js";

// ─── resolveKiloApiKey ────────────────────────────────────────────────────────

describe("resolveKiloApiKey", () => {
  beforeEach(() => {
    delete process.env.KILO_API_KEY;
  });

  it("returns direct apiKey when provided", () => {
    expect(resolveKiloApiKey("direct-key")).toBe("direct-key");
  });

  it("reads from KILO_API_KEY env var when no direct key", () => {
    process.env.KILO_API_KEY = "env-key";
    expect(resolveKiloApiKey(undefined)).toBe("env-key");
  });

  it("returns undefined when neither is available", () => {
    expect(resolveKiloApiKey(undefined)).toBeUndefined();
  });

  it("prefers direct key over env var", () => {
    process.env.KILO_API_KEY = "env-key";
    expect(resolveKiloApiKey("direct-key")).toBe("direct-key");
  });
});

// ─── createKiloGenerator ──────────────────────────────────────────────────────

describe("createKiloGenerator", () => {
  it("creates generator with default model kilo-auto/free", () => {
    const gen = createKiloGenerator("test-key");
    expect(gen).toBeInstanceOf(KiloGenerator);
    expect((gen as any).config.model).toBe("kilo-auto/free");
  });

  it("creates generator with custom model", () => {
    const gen = createKiloGenerator("test-key", "kilo-auto/balanced");
    expect((gen as any).config.model).toBe("kilo-auto/balanced");
  });

  it("creates generator with custom baseURL", () => {
    const gen = createKiloGenerator("test-key", "kilo-auto/free", "https://custom.kilo.ai");
    expect((gen as any).config.baseURL).toBe("https://custom.kilo.ai");
  });

  it("sets default temperature to 0.0", () => {
    const gen = createKiloGenerator("test-key");
    expect((gen as any).config.temperature).toBe(0.0);
  });

  it("sets default maxTokens to 512", () => {
    const gen = createKiloGenerator("test-key");
    expect((gen as any).config.maxTokens).toBe(512);
  });

  it("sets default timeoutMs to 30000", () => {
    const gen = createKiloGenerator("test-key");
    expect((gen as any).config.timeoutMs).toBe(30000);
  });
});

// ─── KILO_BASE_URL ────────────────────────────────────────────────────────────

describe("KILO_BASE_URL", () => {
  it("is the correct Kilo API gateway URL", () => {
    expect(KILO_BASE_URL).toBe("https://api.kilo.ai/api/gateway");
  });
});

// ─── KiloGenerator.generate ───────────────────────────────────────────────────

describe("KiloGenerator.generate", () => {
  let gen: KiloGenerator;
  let mockFetch: any;

  beforeEach(() => {
    gen = createKiloGenerator("test-key", "kilo-auto/free");
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it("calls the correct endpoint with correct headers", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: '{"result": "ok"}' }],
          },
        ],
        usage: { total_tokens: 42 },
      }),
    });

    const schema = z.object({ result: z.string() });
    await gen.generate("test prompt", schema);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.kilo.ai/api/gateway/responses");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer test-key");
    expect(options.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(options.body);
    expect(body.model).toBe("kilo-auto/free");
    expect(body.input[0].role).toBe("system");
    expect(body.input[1].role).toBe("user");
    expect(body.input[1].content).toBe("test prompt");
    expect(body.temperature).toBe(0.0);
    expect(body.max_output_tokens).toBe(512);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("decision");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema).toEqual({
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
      additionalProperties: false,
    });
  });

  it("returns DecisionResult with parsed value", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: '{"result": "ok"}' }],
          },
        ],
        usage: { total_tokens: 42 },
      }),
    });

    const schema = z.object({ result: z.string() });
    const result = await gen.generate("test", schema);

    expect(result.value).toEqual({ result: "ok" });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.tokensUsed).toBe(42);
  });

  it("falls back to choices format when output is empty", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"result": "fallback"}' } }],
        usage: { total_tokens: 10 },
      }),
    });

    const schema = z.object({ result: z.string() });
    const result = await gen.generate("test", schema);

    expect(result.value).toEqual({ result: "fallback" });
  });

  it("throws on 401 with descriptive error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    const schema = z.object({ result: z.string() });
    await expect(gen.generate("test", schema)).rejects.toThrow(
      "Kilo API authentication failed (401)"
    );
  });

  it("throws on 429 with descriptive error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limited",
    });

    const schema = z.object({ result: z.string() });
    await expect(gen.generate("test", schema)).rejects.toThrow(
      "Kilo API rate limited (429)"
    );
  });

  it("throws on other HTTP errors", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Server error",
    });

    const schema = z.object({ result: z.string() });
    await expect(gen.generate("test", schema)).rejects.toThrow(
      "Kilo API error 500"
    );
  });

  it("throws on network error", async () => {
    mockFetch.mockRejectedValue(new Error("Failed to fetch"));

    const schema = z.object({ result: z.string() });
    await expect(gen.generate("test", schema)).rejects.toThrow(
      "Kilo API network error"
    );
  });

  it("throws on timeout (AbortError)", async () => {
    const fastGen = createKiloGenerator("test-key", "kilo-auto/free", undefined, 10);
    mockFetch.mockImplementation(() => new Promise((_, reject) => {
      setTimeout(() => reject(new DOMException("Aborted", "AbortError")), 50);
    }));

    const schema = z.object({ result: z.string() });
    await expect(fastGen.generate("test", schema)).rejects.toThrow(
      "Kilo API request timed out"
    );
  });

  it("throws on empty response", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [],
        usage: { total_tokens: 0 },
      }),
    });

    const schema = z.object({ result: z.string() });
    await expect(gen.generate("test", schema)).rejects.toThrow(
      "Empty response from Kilo API"
    );
  });

  it("handles Zod→JSON Schema conversion for complex schemas", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: '{"category": "bug", "count": 5, "tags": ["a"]}' }],
          },
        ],
        usage: { total_tokens: 20 },
      }),
    });

    const schema = z.object({
      category: z.enum(["bug", "feature"]),
      count: z.number().min(0).max(100),
      tags: z.array(z.string()),
    });
    const result = await gen.generate("test", schema);

    expect(result.value.category).toBe("bug");
    expect(result.value.count).toBe(5);
    expect(result.value.tags).toEqual(["a"]);
  });

  it("supports temperature and maxTokens overrides", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: '{"result": "ok"}' }],
          },
        ],
        usage: { total_tokens: 5 },
      }),
    });

    const schema = z.object({ result: z.string() });
    await gen.generate("test", schema, { temperature: 0.5, maxTokens: 256 });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.temperature).toBe(0.5);
    expect(body.max_output_tokens).toBe(256);
  });
});

// ─── KiloGenerator.generateRaw ────────────────────────────────────────────────

describe("KiloGenerator.generateRaw", () => {
  it("throws not supported error", async () => {
    const gen = createKiloGenerator("test-key");
    await expect(gen.generateRaw("prompt", "grammar")).rejects.toThrow(
      "generateRaw not supported on KiloGenerator"
    );
  });
});

// ─── KiloGenerator.runWorkflow ────────────────────────────────────────────────

describe("KiloGenerator.runWorkflow", () => {
  let gen: KiloGenerator;
  let mockFetch: any;

  beforeEach(() => {
    gen = createKiloGenerator("test-key", "kilo-auto/free");
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it("executes steps with dependency-aware parallelism", async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      const text = callCount === 1
        ? '{"step1": "done"}'
        : '{"step2": "done2"}';
      return Promise.resolve({
        ok: true,
        json: async () => ({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text }],
            },
          ],
          usage: { total_tokens: 10 },
        }),
      });
    });

    const workflow = {
      name: "test-workflow",
      description: "Test",
      steps: [
        {
          name: "step1",
          promptTemplate: "Do step 1",
          schema: z.object({ step1: z.string() }),
        },
        {
          name: "step2",
          promptTemplate: "Do step 2 based on {step1}",
          schema: z.object({ step2: z.string() }),
        },
      ],
    };

    const result = await gen.runWorkflow(workflow, {});

    expect(result.success).toBe(true);
    expect(result.workflowName).toBe("test-workflow");
    expect(result.stepResults.step1).toEqual({ step1: "done" });
    expect(result.stepResults.step2).toEqual({ step2: "done2" });
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it("returns error result on workflow failure", async () => {
    mockFetch.mockRejectedValue(new Error("API down"));

    const workflow = {
      name: "test-workflow",
      description: "Test",
      steps: [
        {
          name: "step1",
          promptTemplate: "Do step 1",
          schema: z.object({ step1: z.string() }),
        },
      ],
    };

    const result = await gen.runWorkflow(workflow, {});

    expect(result.success).toBe(false);
    expect(result.error).toBe("API down");
    expect(result.workflowName).toBe("test-workflow");
  });
});

// ─── zodToJsonSchema ──────────────────────────────────────────────────────────

describe("zodToJsonSchema", () => {
  it("converts simple object schema", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = zodToJsonSchema(schema);
    expect(result).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name", "age"],
      additionalProperties: false,
    });
  });

  it("handles optional fields", () => {
    const schema = z.object({ name: z.string().optional() });
    const result = zodToJsonSchema(schema);
    expect(result.required).toEqual([]);
  });

  it("handles enums", () => {
    const schema = z.object({ status: z.enum(["active", "inactive"]) });
    const result = zodToJsonSchema(schema);
    expect(result.properties.status).toEqual({ type: "string", enum: ["active", "inactive"] });
  });

  it("handles min/max checks on numbers", () => {
    const schema = z.object({ score: z.number().min(0).max(100) });
    const result = zodToJsonSchema(schema);
    expect(result.properties.score).toEqual({ type: "number", minimum: 0, maximum: 100 });
  });

  it("handles min/max checks on strings", () => {
    const schema = z.object({ name: z.string().min(1).max(50) });
    const result = zodToJsonSchema(schema);
    expect(result.properties.name).toEqual({ type: "string", minLength: 1, maxLength: 50 });
  });

  it("falls back to string for unknown types", () => {
    const schema = z.any();
    const result = zodToJsonSchema(schema);
    expect(result).toEqual({ type: "string" });
  });
});
