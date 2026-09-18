import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { News } from "@opencode-ai/news"
import { Config, ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { HttpServer } from "effect/unstable/http"
import { ServerAuth } from "../../src/server/auth"
import { NewsApi } from "../../src/server/routes/instance/httpapi/groups/news"
import { newsHandlers } from "../../src/server/routes/instance/httpapi/handlers/news"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { testEffect } from "../lib/effect"

const catalog: Record<string, ModelsDev.Provider> = {
  maker: {
    id: "maker", name: "Maker", env: [], models: {
      alpha: {
        id: "alpha", name: "Alpha", release_date: "1970-01-01",
        attachment: false, reasoning: false, temperature: true, tool_call: true,
        limit: { context: 32000, output: 4000 },
      },
    },
  },
}
const expected = [{
  id: "maker/alpha", title: "Alpha", description: "Alpha", provider: "Maker",
  model: "alpha", releaseDate: "1970-01-01", type: "model_release",
}]

function api(get: ModelsDev.Interface["get"], password: Option.Option<string>) {
  // Real handler + service + authorization. No instance/workspace layer is
  // supplied: a global news request must not need either one. The api id must
  // match InstanceHttpApi ("opencode-instance") because newsHandlers provides
  // that group's service tag.
  const routes = HttpRouter.serve(HttpApiBuilder.layer(HttpApi.make("opencode-instance").addHttpApi(NewsApi)).pipe(
    Layer.provide(newsHandlers),
    Layer.provide(schemaErrorLayer),
    Layer.provide(News.layer.pipe(Layer.provide(Layer.mock(ModelsDev.Service, { get })))),
    Layer.provide(authorizationLayer),
    Layer.provide(ServerAuth.Config.configLayer({ password, username: "opencode" })),
    Layer.provide(TestClock.layer()),
  ), { disableListenLog: true, disableLogger: true })
  return routes.pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(NodeServices.layer))
}

const it = testEffect(api(() => Effect.succeed(catalog), Option.none()))
const secret = testEffect(api(() => Effect.succeed(catalog), Option.some("secret")))
const unavailable = testEffect(api(() => Effect.die(new Error("catalog unavailable")), Option.none()))

it.live("GET /news emits a bare JSON array without directory context", () =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get("/news")
    expect(response.status).toBe(200)
    expect(response.headers["content-type"]).toContain("application/json")
    expect(yield* response.json).toEqual(expected)
  }),
)

secret.live("GET /news enforces configured auth and accepts valid credentials", () =>
  Effect.gen(function* () {
    for (const password of [undefined, "wrong", "secret"]) {
      const response = yield* HttpClientRequest.get("/news").pipe(
        HttpClientRequest.setHeader("authorization", password ? ServerAuth.header({ username: "opencode", password }) ?? "" : ""),
        HttpClient.execute,
      )
      expect(response.status).toBe(password === "secret" ? 200 : 401)
      if (password === "secret") {
        expect(yield* response.json).toEqual(expected)
        continue
      }
      expect(response.headers["www-authenticate"]).toContain("Basic")
      expect(yield* response.text).toBe("")
    }
  }),
)

unavailable.live("GET /news returns 200 [] on catalog failure", () =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get("/news")
    expect(response.status).toBe(200)
    expect(yield* response.json).toEqual([])
  }),
)

const assembledRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(HttpApiApp.createRoutes().pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: "secret" }))),
), { disableListenLog: true, disableLogger: true })
const assembled = testEffect(assembledRoutes.pipe(Layer.provideMerge(NodeHttpServer.layerTest)))

assembled.live("production assembly provides global News and auth without instance/workspace context", () =>
  Effect.gen(function* () {
    const missing = yield* HttpClient.get("/news")
    expect(missing.status).toBe(401)
    expect(yield* missing.text).toBe("")
    const response = yield* HttpClientRequest.get("/news").pipe(
      HttpClientRequest.setHeader("authorization", ServerAuth.header({ username: "opencode", password: "secret" }) ?? ""),
      HttpClientRequest.setHeader("x-opencode-directory", "/nonexistent/news-must-not-load-an-instance"),
      HttpClient.execute,
    )
    expect(response.status).toBe(200)
    expect(Schema.is(Schema.Array(News.NewsItem))(yield* response.json)).toBe(true)
  }),
)

test("public OpenAPI includes news.list, its array schema and authorization error", () => {
  const doc = OpenApi.fromApi(PublicApi)
  const operation = doc.paths["/news"]?.get
  expect(operation?.operationId).toBe("news.list")
  expect(operation?.responses?.["200"]).toMatchObject({
    content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/NewsItem" } } } },
  })
  expect(OpenApi.fromApi(NewsApi).paths["/news"]?.get?.responses?.["401"]).toBeDefined()
  // PublicApi intentionally strips auth errors/security metadata for all routes.
  expect(operation?.responses?.["401"]).toBeUndefined()
  expect(operation?.parameters ?? []).toEqual([])
  expect(doc.components?.schemas?.NewsItem).toMatchObject({
    required: ["id", "title", "description", "provider", "model", "releaseDate", "type"],
  })
})
