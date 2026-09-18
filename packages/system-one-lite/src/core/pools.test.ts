import { describe, it, expect } from "vitest";
import { buildPools } from "../core/pools.js";

describe("buildPools", () => {
  it("extracts spans from a simple message", () => {
    const pools = buildPools("What is the weather in Denver tomorrow?");
    expect(pools.spans).toEqual(
      expect.arrayContaining(["What", "is", "the", "weather", "in", "Denver", "tomorrow?"])
    );
    expect(pools.text).toBe("What is the weather in Denver tomorrow?");
  });

  it("extracts numbers including currency and percentages", () => {
    const pools = buildPools("The price is $19.99 and growth is 15.5%");
    const values = pools.numbers.map((n) => n.value);
    expect(values).toEqual(
      expect.arrayContaining(["$19.99", "15.5%"])
    );
  });

  it("extracts dates via chrono-node", () => {
    const pools = buildPools("Remind me tomorrow at 5pm");
    expect(pools.dates.length).toBeGreaterThanOrEqual(1);
    expect(pools.dates[0].source).toBe("chrono");
  });

  it("extracts known places from the default list", () => {
    const pools = buildPools("Weather in Denver and Tokyo");
    const placeValues = pools.places.map((p) => p.value);
    expect(placeValues).toEqual(
      expect.arrayContaining(["Denver", "Tokyo"])
    );
  });

  it("extracts people as 2-3 word capitalized runs", () => {
    const pools = buildPools("Ask John Doe about the project");
    const peopleValues = pools.people.map((p) => p.value);
    expect(peopleValues).toEqual(
      expect.arrayContaining(["John Doe"])
    );
  });

  it("does not include places in people", () => {
    const pools = buildPools("Visit New York with John Smith");
    const peopleValues = pools.people.map((p) => p.value);
    expect(peopleValues).not.toEqual(
      expect.arrayContaining(["New York"])
    );
    expect(peopleValues).toEqual(
      expect.arrayContaining(["John Smith"])
    );
  });

  it("preserves recentResults in the pools output", () => {
    const pools = buildPools("test", ["previous result"]);
    expect(pools.recentResults).toEqual(["previous result"]);
  });
});
