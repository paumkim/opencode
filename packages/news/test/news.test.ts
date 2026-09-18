import { expect } from "bun:test"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "../../core/test/lib/effect"
import { News } from "../src"

const now = Date.parse("2026-03-20T00:00:00Z")

function model(id: string, release_date = "2026-03-19", extra: Partial<ModelsDev.Model> = {}): ModelsDev.Model {
  return {
    id,
    name: id,
    release_date,
    attachment: false,
    reasoning: false,
    temperature: true,
    tool_call: true,
    limit: { context: 32000, output: 4000 },
    ...extra,
  }
}

function provider(id: string, models: ModelsDev.Model[]): ModelsDev.Provider {
  return { id, name: id.toUpperCase(), env: [], models: Object.fromEntries(models.map((m) => [m.id, m])) }
}

const it = testEffect(Layer.empty)

function list(catalog: Record<string, ModelsDev.Provider>, time = now) {
  return Effect.gen(function* () {
    yield* TestClock.setTime(time)
    const news = yield* News.Service
    return yield* news.list()
  }).pipe(Effect.provide(News.layer.pipe(Layer.provide(Layer.mock(ModelsDev.Service, {
    get: () => Effect.succeed(catalog),
  })))))
}

it.effect("accepts only real ISO dates within the inclusive 30-day window, not future releases", () =>
  Effect.gen(function* () {
    const items = yield* list({
      maker: provider("maker", [
        model("today", "2026-03-20"),
        model("cutoff", "2026-02-18"),
        model("old", "2026-02-17"),
        model("future", "2026-03-21"),
        model("invalid", "garbage"),
        model("empty", ""),
        model("rollover", "2026-02-30"),
        model("non-leap", "2026-02-29"),
        model("partial", "2026-03"),
        model("timestamp", "2026-03-19T00:00:00Z"),
      ]),
    })
    expect(items.map((item) => item.model)).toEqual(["today", "cutoff"])
  }),
)

it.effect("uses the request clock, including sub-day cutoff and leap-day validation", () =>
  Effect.gen(function* () {
    const catalog = { maker: provider("maker", [model("boundary", "2026-02-18")]) }
    expect(yield* list(catalog)).toHaveLength(1)
    expect(yield* list(catalog, now + 1)).toEqual([])
    expect(yield* list({ maker: provider("maker", [model("leap", "2024-02-29")]) }, Date.parse("2024-03-01")))
      .toHaveLength(1)
  }),
)

it.effect("emits the declared wire fields and omits unknown URLs", () =>
  Effect.gen(function* () {
    const items = yield* list({ maker: provider("maker", [model("alpha", undefined, { name: "Alpha", family: "A" })]) })
    expect(items).toEqual([{
      id: "maker/alpha", title: "Alpha", description: "A — Alpha", provider: "MAKER",
      model: "alpha", releaseDate: "2026-03-19", type: "model_release",
    }])
    expect(Schema.is(Schema.Array(News.NewsItem))(items)).toBe(true)
    expect((yield* list({ maker: provider("maker", [model("plain")]) }))[0].description).toBe("plain")
  }),
)

it.effect("deduplicates confirmed owner listings, keeping unrelated IDs, variants and dates", () =>
  Effect.gen(function* () {
    const original = model("alpha", undefined, { name: "Alpha", family: "A" })
    const catalog = {
      reseller: provider("reseller", [
        { ...original, id: "maker/alpha" },
        { ...original, id: "other/alpha" },
        { ...original, id: "maker/alpha:free" },
        { ...original, id: "alpha" },
      ]),
      maker: provider("maker", [original]),
      other: provider("other", [{ ...original, name: "Unrelated Alpha" }]),
      changed: provider("changed", [{ ...original, id: "maker/alpha", release_date: "2026-03-18" }]),
      variant: provider("variant", [{ ...original, id: "maker/alpha", family: "B" }]),
    }
    const items = yield* list(catalog)
    expect(items).toHaveLength(7)
    expect(items.find((item) => item.id === "maker/alpha")?.provider).toBe("MAKER")
    expect(items.some((item) => item.id === "reseller/maker/alpha")).toBe(false)
    expect(items.map((item) => item.id)).toContain("reseller/other/alpha")
    expect(items.map((item) => item.id)).toContain("reseller/maker/alpha:free")
    expect(yield* list(Object.fromEntries(Object.entries(catalog).reverse()))).toEqual(items)
  }),
)

it.effect("sorts newest first with a locale-independent ID tie-break and limits after dedup", () =>
  Effect.gen(function* () {
    const models = Array.from({ length: 25 }, (_, i) => model(`m${String(i).padStart(2, "0")}`))
    const catalog = {
      reseller: provider("reseller", models.map((m) => ({ ...m, id: `maker/${m.id}` }))),
      maker: provider("maker", [...models, model("newest", "2026-03-20")]),
    }
    const items = yield* list(catalog)
    expect(items).toHaveLength(20)
    expect(items.map((item) => item.model)).toEqual(["newest", ...models.slice(0, 19).map((m) => m.id)])
    expect(yield* list({ maker: provider("maker", Object.values(catalog.maker.models).reverse()), reseller: catalog.reseller })).toEqual(items)
  }),
)

it.effect("does not reject release news when an unrelated capability field is absent", () =>
  Effect.gen(function* () {
    const tts = model("mimo-v2.5-tts")
    Reflect.deleteProperty(tts, "temperature")
    const items = yield* list({
      maker: provider("maker", [model("alpha")]),
      "xiaomi-token-plan-cn": provider("xiaomi-token-plan-cn", [tts]),
    })
    expect(items.map((item) => item.id)).toEqual(["maker/alpha", "xiaomi-token-plan-cn/mimo-v2.5-tts"])
  }),
)

it.effect("returns empty news for an empty catalog", () =>
  Effect.gen(function* () {
    expect(yield* list({})).toEqual([])
  }),
)

it.effect("recovers from catalog network/parse defects and retries on the next list", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now)
    const news = yield* News.Service
    expect(yield* news.list()).toEqual([])
    expect(yield* news.list()).toEqual([])
    expect(yield* news.list()).toHaveLength(1)
  }).pipe(Effect.provide(News.layer.pipe(Layer.provide(Layer.sync(ModelsDev.Service, () => {
    const results = [
      Effect.die(new Error("network unavailable")),
      Effect.die(new SyntaxError("invalid catalog JSON")),
      Effect.succeed({ maker: provider("maker", [model("alpha")]) }),
    ]
    return ModelsDev.Service.of({ get: () => results.shift() ?? Effect.succeed({}), refresh: () => Effect.void })
  }))))),
)

it.effect("does not turn cancellation into successful empty news", () =>
  Effect.gen(function* () {
    const news = yield* News.Service
    const exit = yield* Effect.exit(news.list())
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  }).pipe(Effect.provide(News.layer.pipe(Layer.provide(Layer.mock(ModelsDev.Service, {
    get: () => Effect.interrupt,
  }))))),
)
