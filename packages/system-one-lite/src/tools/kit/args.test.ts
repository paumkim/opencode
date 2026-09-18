import { describe, it, expect } from "vitest";
import { Args, type MissingArg } from "./args.js";
import { buildPools } from "../../core/pools.js";

describe("Args", () => {
  const pools = buildPools("weather in Denver tomorrow");

  it("pick records a value from a pool", () => {
    const args = new Args({ city: "Denver" }, pools);
    args.pick("city", "places");
    const { args: built, traces } = args.build();
    expect(built.city).toBe("Denver");
    expect(traces).toContainEqual({
      key: "city",
      value: "Denver",
      source: "jev",
      fromPool: "places",
    });
  });

  it("option records a choice answer or default", () => {
    const args = new Args({ mode: "quick" }, pools);
    args.option("mode", "deep");
    const { args: built, traces } = args.build();
    expect(built.mode).toBe("quick");
    expect(traces).toContainEqual({
      key: "mode",
      value: "quick",
      source: "jev",
    });
  });

  it("option falls back to default when answer is missing", () => {
    const args = new Args({}, pools);
    args.option("mode", "deep");
    const { args: built, traces } = args.build();
    expect(built.mode).toBe("deep");
    expect(traces).toContainEqual({
      key: "mode",
      value: "deep",
      source: "default",
    });
  });

  it("set records an explicit code value", () => {
    const args = new Args({}, pools);
    args.set("fixed", 42);
    const { traces } = args.build();
    expect(traces).toContainEqual({
      key: "fixed",
      value: 42,
      source: "code",
    });
  });

  it("fixed records send-only code value", () => {
    const args = new Args({}, pools);
    args.fixed("hidden", "secret");
    const { args: built, traces } = args.build();
    expect(built.hidden).toBe("secret");
    expect(traces).toContainEqual({
      key: "hidden",
      value: "secret",
      source: "code",
    });
  });

  it("note records show-only code value", () => {
    const args = new Args({}, pools);
    args.note("display", "shown");
    const { args: built, traces } = args.build();
    expect(built.display).toBeUndefined();
    expect(traces).toContainEqual({
      key: "display",
      value: "shown",
      source: "code",
    });
  });

  it("require returns missing when key is absent", () => {
    const args = new Args({}, pools);
    const missing: MissingArg | null = args.require("target", "Which target?");
    expect(missing).toEqual({ missing: "target", question: "Which target?" });
  });

  it("require returns null when key is present", () => {
    const args = new Args({ target: "foo" }, pools);
    const missing: MissingArg | null = args.require("target", "Which target?");
    expect(missing).toBeNull();
  });

  it("build returns args and traces without send/show-only values", () => {
    const args = new Args({ a: "1" }, pools);
    args.set("a", "1");
    args.note("b", "2");
    args.fixed("c", "3");
    const { args: built } = args.build();
    expect(built).toEqual({ a: "1", c: "3" });
  });
});
