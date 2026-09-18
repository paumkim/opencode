import { expect, test } from "bun:test"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { shouldCompactRequest } from "@/session/overflow"
import { Token } from "@/util/token"
import type { ModelMessage } from "ai"

test("preflight uses resolved reasoning output once and respects capacity ceilings", () => {
  const model = {
    limit: { context: 100_000, output: 64_000 },
    capabilities: { reasoning: true },
  } as Provider.Model
  const outputTokenMax = ProviderTransform.maxOutputTokens(model)
  expect(outputTokenMax).toBe(40_192)
  expect(model.limit.context - outputTokenMax).toBe(59_808)
  expect(model.limit.context - ProviderTransform.maxOutputTokens(model, outputTokenMax)).toBe(51_616)

  // Build real messages at adjacent estimator steps around each capacity.
  function boundary(capacity: number, options: Partial<Parameters<typeof shouldCompactRequest>[0]> = {}) {
    for (const above of [false, true]) {
      const estimate = Math.floor((capacity - 1) / 1.3) + Number(above)
      const empty: ModelMessage[] = [{ role: "user", content: "" }]
      const messages: ModelMessage[] = [{
        role: "user",
        content: "x".repeat((estimate - Token.estimate("[]")) * 4 - JSON.stringify(empty).length),
      }]
      const tokens = Math.ceil((Token.estimate(JSON.stringify(messages)) + Token.estimate("[]")) * 1.3)
      expect(tokens >= capacity).toBe(above)
      if (capacity === 59_808) expect(tokens).toBe(above ? 59_808 : 59_807)
      expect(shouldCompactRequest({
        cfg: { compaction: { threshold: 1 } },
        model,
        outputTokenMax,
        ...options,
        messages,
        tools: {},
      })).toBe(above)
    }
  }

  boundary(59_808)
  boundary(59_808, { outputTokenMax: undefined })
  // An input ceiling must not bypass context minus resolved output.
  boundary(59_808, { model: { ...model, limit: { ...model.limit, input: 90_000 } } })
  boundary(30_000, { model: { ...model, limit: { ...model.limit, input: 50_000 } } })
  boundary(45_000, {
    model: { ...model, limit: { ...model.limit, input: 50_000 } },
    cfg: { compaction: { threshold: 1, reserved: 5_000 } },
  })
  boundary(50_000, { cfg: { compaction: { threshold: 0.5 } } })
  boundary(25_000, {
    model: { ...model, limit: { ...model.limit, input: 50_000 } },
    cfg: { compaction: { threshold: 0.5 } },
  })
})
