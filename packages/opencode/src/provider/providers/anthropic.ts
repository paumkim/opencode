import { Effect } from "effect"
import type { CustomDep, CustomLoader, Info, Model } from "../provider"


export function anthropic(dep: CustomDep): CustomLoader {
  return () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
            "X-BILLING-INVOKE-ORIGIN": "OpenCode",
          },
        },
      })
}
