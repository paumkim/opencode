import { Effect } from "effect"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import os from "os"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { CustomDep, CustomLoader, Info, Model } from "../provider"


export function devin(dep: CustomDep): CustomLoader {
  return Effect.fnUntraced(function* (input: Info) {
      const env = yield* dep.env()
      const auth = yield* dep.auth(input.id)
      const apiKey = auth?.type === "api" ? auth.key : env["DEVIN_API_KEY"]
      const orgId = auth?.type === "api" ? auth.metadata?.orgId : env["DEVIN_ORG_ID"]

      if (!apiKey) {
        return { autoload: false }
      }

      const userAgent = `opencode/${InstallationVersion} devin (${os.platform()} ${os.release()}; ${os.arch()})`

      return {
        autoload: false,
        options: {
          baseURL: "https://api.devin.ai/v3",
          apiKey,
          headers: {
            "User-Agent": userAgent,
            "X-Client-Info": "opencode",
          },
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers)
            if (!headers.has("User-Agent")) headers.set("User-Agent", userAgent)
            if (!headers.has("X-Client-Info")) headers.set("X-Client-Info", "opencode")
            return fetch(input, { ...init, headers })
          },
        },
        vars(_options: Record<string, any>) {
          return { DEVIN_API_KEY: apiKey }
        },
        async discoverModels(): Promise<Record<string, Model>> {
          if (!orgId || !apiKey) {
            return {
              "devin-1": {
                id: ModelV2.ID.make("devin-1"),
                providerID: ProviderV2.ID.make("devin"),
                name: "Devin",
                family: "devin",
                api: {
                  id: "devin-1",
                  url: "https://api.devin.ai/v3",
                  npm: "@ai-sdk/openai",
                },
                status: "active",
                headers: {},
                options: {},
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                limit: { context: 0, output: 0 },
                capabilities: {
                  temperature: false,
                  reasoning: false,
                  attachment: true,
                  toolcall: true,
                  input: { text: true, audio: false, image: true, video: false, pdf: true },
                  output: { text: true, audio: false, image: false, video: false, pdf: false },
                  interleaved: false,
                },
                release_date: "",
                variants: {},
              },
            }
          }

          try {
            const res = await fetch(`https://api.devin.ai/v3/organizations/${orgId}/models`, {
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "User-Agent": userAgent,
                "X-Client-Info": "opencode",
              },
            })

            if (!res.ok) {
              return {}
            }

            const data = (await res.json()) as { models?: Array<{ id: string; name?: string }> }
            const models: Record<string, Model> = {}

            for (const m of data.models ?? []) {
              models[m.id] = {
                id: ModelV2.ID.make(m.id),
                providerID: ProviderV2.ID.make("devin"),
                name: m.name ?? m.id,
                family: "devin",
                api: {
                  id: m.id,
                  url: "https://api.devin.ai/v3",
                  npm: "@ai-sdk/openai",
                },
                status: "active",
                headers: {},
                options: {},
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                limit: { context: 0, output: 0 },
                capabilities: {
                  temperature: false,
                  reasoning: false,
                  attachment: true,
                  toolcall: true,
                  input: { text: true, audio: false, image: true, video: false, pdf: true },
                  output: { text: true, audio: false, image: false, video: false, pdf: false },
                  interleaved: false,
                },
                release_date: "",
                variants: {},
              }
            }

            return models
          } catch {
            return {}
          }
        },
      }
    })
}
