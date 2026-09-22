import { Effect } from "effect"
import type { CustomDep, CustomLoader, Info, Model } from "../provider"


export function nvidia(dep: CustomDep): CustomLoader {
  return (provider) =>
      Effect.succeed({
        autoload: provider.source === "config",
        options: {
          headers: {
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
            "X-BILLING-INVOKE-ORIGIN": "OpenCode",
          },
        },
      })
}
