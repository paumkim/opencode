export * as ModelCapabilities from "./capabilities"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { ModelV2 } from "../model"
import { SystemContext } from "../system-context"

const Summary = Schema.Struct({
  name: Schema.String,
  providerID: Schema.String,
  modelID: Schema.String,
  contextWindow: Schema.Int,
  tools: Schema.Boolean,
  input: Schema.Array(Schema.String),
  output: Schema.Array(Schema.String),
  status: Schema.String,
})
type Summary = typeof Summary.Type

const render = (summary: Summary) =>
  [
    `Model: ${summary.name} (${summary.providerID}/${summary.modelID})`,
    `Context window: ${summary.contextWindow} tokens`,
    `Tools: ${summary.tools ? "yes" : "no"}`,
    `Input modalities: ${summary.input.length === 0 ? "none" : summary.input.join(", ")}`,
    `Output modalities: ${summary.output.length === 0 ? "none" : summary.output.join(", ")}`,
    `Status: ${summary.status}`,
  ].join("\n")

export interface Interface {
  readonly load: (model: ModelV2.Info) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ModelCapabilities") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of({
      load: Effect.fn("ModelCapabilities.load")(function* (model) {
        const summary: Summary = {
          name: model.name,
          providerID: model.providerID,
          modelID: model.id,
          contextWindow: model.limit.context,
          tools: model.capabilities.tools,
          input: model.capabilities.input,
          output: model.capabilities.output,
          status: model.status,
        }
        return SystemContext.make({
          key: SystemContext.Key.make("core/model-capabilities"),
          codec: Schema.toCodecJson(Summary),
          load: Effect.succeed(summary),
          baseline: render,
          update: (_previous, current) =>
            [
              "The model capabilities have changed. This information supersedes the previous model capabilities.",
              render(current),
            ].join("\n"),
          removed: () =>
            "Model capabilities are no longer available. Do not reference previously listed model capabilities.",
        })
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [] })
