import { Effect } from "effect"
import type { CustomDep, CustomLoader, Info, Model } from "../provider"


export function xai(dep: CustomDep): CustomLoader {
  return () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: {},
      })
}
