import { Effect } from "effect"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import os from "os"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { CustomDep, CustomLoader, Info, Model } from "../provider"

// Known models available through Codeium's gateway (from Devin CLI `models list`)
const KNOWN_CODECIUM_MODELS: readonly string[] = [
  "claude-opus-5",
  "claude-opus-5-low",
  "claude-opus-5-medium",
  "claude-opus-5-high",
  "claude-opus-5-xhigh",
  "claude-opus-5-max",
  "claude-opus-5-low-fast",
  "claude-opus-5-medium-fast",
  "claude-opus-5-high-fast",
  "claude-opus-5-xhigh-fast",
  "claude-opus-5-max-fast",
  "claude-fable-5-1",
  "claude-fable-5-1-low",
  "claude-fable-5-1-medium",
  "claude-fable-5-1-high",
  "claude-fable-5-1-xhigh",
  "claude-fable-5-1-max",
  "gpt-5-4",
  "gpt-5-4-none",
  "gpt-5-4-low",
  "gpt-5-4-medium",
  "gpt-5-4-high",
  "gpt-5-4-xhigh",
  "gpt-5-4-none-priority",
  "gpt-5-4-low-priority",
  "gpt-5-4-medium-priority",
  "gpt-5-4-high-priority",
  "gpt-5-4-xhigh-priority",
  "gpt-5-3-codex",
  "gpt-5-3-codex-low",
  "gpt-5-3-codex-medium",
  "gpt-5-3-codex-high",
  "gpt-5-3-codex-xhigh",
  "gpt-5-3-codex-low-priority",
  "gpt-5-3-codex-medium-priority",
  "gpt-5-3-codex-high-priority",
  "gpt-5-3-codex-xhigh-priority",
  "gemini-3-1-pro",
  "gemini-3-1-pro-low",
  "gemini-3-1-pro-high",
  "gemini-3-flash",
  "gemini-3-flash-minimal",
  "gemini-3-flash-low",
  "gemini-3-flash-medium",
  "gemini-3-flash-high",
  "deepseek-v4-pro",
  "deepseek-v4-pro-high",
  "deepseek-v4-pro-max",
  "kimi-k2-6",
  "kimi-k2-7",
  "swe-1-6",
  "swe-1-6-fast",
]

export function codeium(dep: CustomDep): CustomLoader {
  return Effect.fnUntraced(function* (input: Info) {
    const env = yield* dep.env()
    const auth = yield* dep.auth(input.id)
    const apiKey = auth?.type === "api" ? auth.key : env["WINDSURF_API_KEY"]

    if (!apiKey) {
      return { autoload: false }
    }

    const userAgent = `opencode/${InstallationVersion} codeium (${os.platform()} ${os.release()}; ${os.arch()})`

    return {
      autoload: true,
      options: {
        baseURL: "https://server.codeium.com",
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
        return { WINDSURF_API_KEY: apiKey }
      },
      async discoverModels(): Promise<Record<string, Model>> {
        const models: Record<string, Model> = {}

        for (const modelID of KNOWN_CODECIUM_MODELS) {
          const displayName = modelID
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase())
            .replace("Gpt", "GPT")
            .replace("Claude", "Claude")
            .replace("Gemini", "Gemini")
            .replace("Deepseek", "DeepSeek")
            .replace("Swe", "SWE")
            .replace("Kimi", "Kimi")

          models[modelID] = {
            id: ModelV2.ID.make(modelID),
            providerID: ProviderV2.ID.make("codeium"),
            name: displayName,
            family: "codeium",
            api: {
              id: modelID,
              url: "https://server.codeium.com",
              npm: "@ai-sdk/openai",
            },
            status: "active",
            headers: {},
            options: {},
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: 128000, output: 16384 },
            capabilities: {
              temperature: true,
              reasoning: true,
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
      },
    }
  })
}
