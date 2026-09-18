import { News } from "@opencode-ai/news"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const newsHandlers = HttpApiBuilder.group(InstanceHttpApi, "news", (handlers) =>
  Effect.gen(function* () {
    const news = yield* News.Service

    const list = Effect.fn("NewsHttpApi.list")(function* () {
      return yield* news.list()
    })

    return handlers.handle("list", list)
  }),
)