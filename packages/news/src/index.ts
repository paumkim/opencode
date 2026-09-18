import { ModelsDev } from "@opencode-ai/core/models-dev"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Cause, Clock, Effect, Layer, Context, Schema, Types } from "effect"

const NEWS_WINDOW_DAYS = 30
const NEWS_LIMIT = 20

// News only consumes release metadata; capability drift must not hide all releases.
const ReleaseCatalog = Schema.Record(Schema.String, Schema.Struct({
  name: Schema.String,
  models: Schema.Record(Schema.String, Schema.Struct({
    name: Schema.String,
    family: Schema.optional(Schema.String),
    release_date: Schema.String,
  })),
}))

export const NewsItem = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  releaseDate: Schema.String,
  url: Schema.optional(Schema.String),
  type: Schema.Literal("model_release"),
}).annotate({ identifier: "NewsItem" })

export type NewsItem = Types.DeepMutable<Schema.Schema.Type<typeof NewsItem>>

export interface Interface {
  readonly list: () => Effect.Effect<readonly NewsItem[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/News") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const models = yield* ModelsDev.Service

    const list = Effect.fn("News.list")(function* () {
      // ModelsDev promotes network/parse failures to defects. News is optional,
      // but request cancellation must still propagate.
      const catalog = yield* Effect.suspend(() => models.get()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ReleaseCatalog)),
        Effect.orDie,
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("Model release news unavailable", cause).pipe(
                Effect.as({} as typeof ReleaseCatalog.Type),
              ),
        ),
      )
      const now = yield* Clock.currentTimeMillis
      const cutoff = now - NEWS_WINDOW_DAYS * 24 * 60 * 60 * 1000

      const items = new Map<string, NewsItem>()
      for (const [providerId, provider] of Object.entries(catalog)) {
        for (const [modelId, model] of Object.entries(provider.models)) {
          const released = Date.parse(model.release_date)
          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(model.release_date) ||
            !Number.isFinite(released) ||
            new Date(released).toISOString().slice(0, 10) !== model.release_date ||
            released < cutoff ||
            released > now
          ) continue

          // Only collapse explicit owner/model listings that match an official
          // entry. Names, families and bare IDs alone are not model identities.
          const slash = modelId.indexOf("/")
          const ownerId = modelId.slice(0, slash)
          const ownedId = modelId.slice(slash + 1)
          const owner = slash > 0 ? catalog[ownerId] : undefined
          const original = owner?.models[ownedId]
          const duplicate = original && original.name === model.name &&
            original.release_date === model.release_date && original.family === model.family
          const id = duplicate ? `${ownerId}/${ownedId}` : `${providerId}/${modelId}`
          items.set(id, {
            id,
            title: model.name,
            description: model.family ? `${model.family} — ${model.name}` : model.name,
            provider: duplicate ? owner.name : provider.name,
            model: duplicate ? ownedId : modelId,
            releaseDate: model.release_date,
            type: "model_release",
          })
        }
      }

      return [...items.values()].sort((a, b) =>
        Date.parse(b.releaseDate) - Date.parse(a.releaseDate) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      ).slice(0, NEWS_LIMIT)
    })

    return Service.of({ list })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [ModelsDev.node] })

export * as News from "."