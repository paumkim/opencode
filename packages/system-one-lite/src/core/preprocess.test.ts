import { describe, it, expect, vi } from "vitest";
import { resolveFollowUp, type PendingQuestion } from "../core/preprocess.js";
import { buildPools } from "../core/pools.js";

describe("resolveFollowUp", () => {
  const buildPending = (type: PendingQuestion["type"], currentValue: string): PendingQuestion => ({
    key: "target",
    type,
    currentValue,
  });

  it("returns unchanged when no pending question is provided", () => {
    const pools = buildPools("Boston");
    const result = resolveFollowUp("Boston", pools);
    expect(result.text).toBe("Boston");
    expect(result.fixes).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });

  it("returns unchanged when message is longer than 50 chars", () => {
    const longMessage = "This is a very long message that exceeds the fifty character limit";
    const pools = buildPools(longMessage);
    const pending = buildPending("place", "weather in Denver");
    const result = resolveFollowUp(longMessage, pools, pending);
    expect(result.text).toBe(longMessage);
    expect(result.fixes).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });

  it("swaps a place follow-up silently when pending question is a place", () => {
    const pools = buildPools("Boston");
    const pending = buildPending("place", "weather in Denver");
    const result = resolveFollowUp("Boston", pools, pending);
    expect(result.text).toBe("Boston");
    expect(result.fixes).toEqual([]);
  });

  it("swaps a date follow-up silently when pending question is a date", () => {
    const pools = buildPools("tomorrow");
    const pending = buildPending("date", "meet today");
    const result = resolveFollowUp("tomorrow", pools, pending);
    expect(result.text).toBe("tomorrow");
  });

  it("generates rewrite candidates for non-swappable follow-ups", () => {
    const pools = buildPools("urgent");
    const pending = buildPending("choice", "review the PR");
    const result = resolveFollowUp("urgent", pools, pending);
    expect(result.suggestions.length).toBeGreaterThanOrEqual(1);
    expect(result.suggestions[0].suggestions).toEqual([]);
  });
});
