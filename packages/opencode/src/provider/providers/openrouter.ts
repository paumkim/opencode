import { Effect } from "effect"
import type { CustomDep, CustomLoader, Info, Model } from "../provider"


export function openrouter(dep: CustomDep): CustomLoader {
  return () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
            "X-BILLING-INVOKE-ORIGIN": "OpenCode",
          },
        },
      })
}
