import { describe, expect, test } from "bun:test"
import { formatModelFooter, formatPrice } from "../../src/util/model-categories"

describe("util.model-categories pricing", () => {
  test("catalog cost is already per-million — do not multiply again", () => {
    // gpt-5.3-codex-spark in models-api.json: { input: 1.75, output: 14 }
    // means $1.75/M input, $14/M output.
    const footer = formatModelFooter({
      cost: { input: 1.75, output: 14 },
      limit: { context: 1_000_000 },
    })
    expect(footer).toBe("$1.75 in / $14 out · 1M")
  })

  test("equal input/output collapse to a single /M rate", () => {
    expect(formatModelFooter({ cost: { input: 2, output: 2 } })).toBe("$2/M")
  })

  test("free models show Free with context suffix", () => {
    expect(formatModelFooter({ cost: { input: 0, output: 0 }, limit: { context: 200_000 } })).toBe(
      "Free · 200k",
    )
  })

  test("formatPrice handles sub-dollar and large values", () => {
    expect(formatPrice(1.75)).toBe("1.75")
    expect(formatPrice(14)).toBe("14")
    expect(formatPrice(1250)).toBe("1250")
    expect(formatPrice(0.0025)).toBe("0.0025")
  })
})