import { Effect } from "effect"
import type { CustomDep, CustomLoader, Info, Model } from "../provider"


export function vercel(dep: CustomDep): CustomLoader {
  return () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "http-referer": "https://opencode.ai/",
            "x-title": "opencode",
            "x-billing-invoke-origin": "OpenCode",
          },
        },
      })
}
