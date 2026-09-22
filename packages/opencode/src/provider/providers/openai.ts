import { Effect } from "effect"
import { OPENAI_HEADER_TIMEOUT_DEFAULT } from "../provider"
import type { CustomDep, CustomLoader, Info, Model } from "../provider"


export function openai(dep: CustomDep): CustomLoader {
  return () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: { headerTimeout: OPENAI_HEADER_TIMEOUT_DEFAULT },
      })
}
