import { Effect } from "effect"
import type { CustomDep, CustomLoader, Info, Model } from "../provider"


export function cerebras(dep: CustomDep): CustomLoader {
  return () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "X-Cerebras-3rd-Party-Integration": "opencode",
            "X-BILLING-INVOKE-ORIGIN": "OpenCode",
          },
        },
      })
}
