import { NewsItem } from "@opencode-ai/news"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"
import { Authorization } from "../middleware/authorization"

const root = "/news"

export const NewsApi = HttpApi.make("news")
  .add(
    HttpApiGroup.make("news")
      .add(
        HttpApiEndpoint.get("list", root, {
          success: described(Schema.Array(NewsItem), "List of recent model release news"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "news.list",
            summary: "List news",
            description: "Get a curated list of recently released AI models from across providers.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "news",
          description: "News and model release updates.",
        }),
      )
      // The catalog is global; do not initialize an instance or route a workspace.
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode news HttpApi",
      version: "0.0.1",
      description: "News and model release updates.",
    }),
  )