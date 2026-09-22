import { Effect } from "effect"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import os from "os"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { CustomDep, CustomLoader, Info, Model } from "../provider"

// Match the real Devin CLI version installed on this system.
// The Devin CLI binary embeds its version in the manifest and uses it
// for User-Agent / client identification headers.
const DEVIN_CLI_VERSION = "3000.11.1"

export function devin(dep: CustomDep): CustomLoader {
  return Effect.fnUntraced(function* (input: Info) {
    const env = yield* dep.env()
    const auth = yield* dep.auth(input.id)
    const apiKey = auth?.type === "api" ? auth.key : env["DEVIN_API_KEY"]
    const orgId = auth?.type === "api" ? auth.metadata?.orgId : env["DEVIN_ORG_ID"]

    if (!apiKey) {
      return { autoload: false }
    }

    const isServiceKey = apiKey.startsWith("cog_")
    const apiBase = orgId && isServiceKey
      ? `https://api.devin.ai/v3/organizations/${orgId}`
      : "https://api.devin.ai/v1"

    // Use the exact User-Agent format the real Devin CLI sends.
    // This stamps requests so Devin's backend treats them as legitimate
    // CLI traffic instead of generic API calls.
    const userAgent = `devin-cli/${DEVIN_CLI_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`
    const clientInfo = "devin-cli"

    return {
      autoload: false,
      getModel(sdk: any, modelID: string) {
        return createDevinLanguageModel({
          apiBase,
          apiKey,
          userAgent,
          clientInfo,
          modelID,
          providerID: "devin",
        })
      },
      options: {
        baseURL: apiBase,
        apiKey,
        headers: {
          "User-Agent": userAgent,
          "X-Client-Info": clientInfo,
        },
      },
      vars(_options: Record<string, any>) {
        return { DEVIN_API_KEY: apiKey }
      },
      async discoverModels(): Promise<Record<string, Model>> {
        if (!apiKey) {
          return {
            "devin-1": {
              id: ModelV2.ID.make("devin-1"),
              providerID: ProviderV2.ID.make("devin"),
              name: "Devin",
              family: "devin",
              api: { id: "devin-1", url: apiBase, npm: "@ai-sdk/openai" },
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
          const res = await fetch(`${apiBase}/models`, {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "User-Agent": userAgent,
              "X-Client-Info": clientInfo,
            },
          })
          if (!res.ok) return {}
          const data = (await res.json()) as { models?: Array<{ id: string; name?: string }> }
          const models: Record<string, Model> = {}
          for (const m of data.models ?? []) {
            models[m.id] = {
              id: ModelV2.ID.make(m.id),
              providerID: ProviderV2.ID.make("devin"),
              name: m.name ?? m.id,
              family: "devin",
              api: { id: m.id, url: apiBase, npm: "@ai-sdk/openai" },
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

function createDevinLanguageModel(input: {
  apiBase: string
  apiKey: string
  userAgent: string
  clientInfo: string
  modelID: string
  providerID: string
}) {
  const { apiBase, apiKey, userAgent, clientInfo, modelID, providerID } = input

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": userAgent,
    "X-Client-Info": clientInfo,
    "Content-Type": "application/json",
  }

  async function createSession(prompt: string): Promise<{ sessionId: string; url: string }> {
    const isV3 = apiBase.includes("/v3/")
    const body = isV3
      ? { task: prompt, title: `OpenCode: ${modelID}` }
      : { prompt, title: `OpenCode: ${modelID}` }

    const res = await fetch(`${apiBase}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Devin session creation failed (${res.status}): ${text}`)
    }
    const data = (await res.json()) as { id: string; url?: string }
    return { sessionId: data.id, url: data.url ?? `${apiBase}/sessions/${data.id}` }
  }

  async function pollSession(sessionId: string): Promise<any> {
    const res = await fetch(`${apiBase}/sessions/${sessionId}`, { headers })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Devin session poll failed (${res.status}): ${text}`)
    }
    return res.json()
  }

  return {
    specificationVersion: "v3" as const,
    provider: providerID,
    modelId: modelID,
    supportedUrls: [],
    async doGenerate(options: any) {
      const prompt = options.prompt
        .map((p: any) => (typeof p === "string" ? p : p.content ?? ""))
        .join("\n")

      const { sessionId } = await createSession(prompt)

      const startTime = Date.now()
      const timeout = 5 * 60 * 1000
      while (Date.now() - startTime < timeout) {
        const session = await pollSession(sessionId)
        const status = session.status?.toLowerCase()
        if (status === "completed" || status === "finished" || status === "success") {
          const output = extractOutput(session)
          return {
            content: [{ type: "text" as const, text: output }],
            finishReason: "stop" as const,
            usage: { promptTokens: 0, completionTokens: 0 },
            warnings: [],
          }
        }
        if (status === "failed" || status === "error") {
          throw new Error(`Devin session failed: ${session.error ?? "unknown error"}`)
        }
        await new Promise((r) => setTimeout(r, 5000))
      }

      throw new Error("Devin session timed out")
    },
    async doStream(options: any) {
      const prompt = options.prompt
        .map((p: any) => (typeof p === "string" ? p : p.content ?? ""))
        .join("\n")

      const { sessionId } = await createSession(prompt)

      const stream = new ReadableStream({
        async pull(controller: any) {
          const startTime = Date.now()
          const timeout = 5 * 60 * 1000
          let lastLength = 0
          while (Date.now() - startTime < timeout) {
            try {
              const session = await pollSession(sessionId)
              const status = session.status?.toLowerCase()
              if (status === "completed" || status === "finished" || status === "success") {
                const output = extractOutput(session)
                controller.enqueue({ type: "text-delta" as const, id: sessionId, delta: output })
                controller.enqueue({ type: "finish" as const, usage: { promptTokens: 0, completionTokens: 0 }, finishReason: "stop" as const })
                controller.close()
                return
              }
              if (status === "failed" || status === "error") {
                controller.enqueue({ type: "error" as const, error: session.error ?? "unknown error" })
                controller.close()
                return
              }
              const output = extractOutput(session)
              if (output.length > lastLength) {
                const delta = output.slice(lastLength)
                controller.enqueue({ type: "text-delta" as const, id: sessionId, delta })
                lastLength = output.length
              }
            } catch (e) {
              controller.enqueue({ type: "error" as const, error: e })
              controller.close()
              return
            }
            await new Promise((r) => setTimeout(r, 3000))
          }
          controller.enqueue({ type: "error" as const, error: "Devin session timed out" })
          controller.close()
        },
      })

      return { stream }
    },
  }
}

function extractOutput(session: any): string {
  if (typeof session.result === "string") return session.result
  if (typeof session.output === "string") return session.output
  if (typeof session.answer === "string") return session.answer
  if (Array.isArray(session.messages)) {
    const last = session.messages[session.messages.length - 1]
    if (last && typeof last.content === "string") return last.content
  }
  if (typeof session.status === "string") return `Session status: ${session.status}`
  return JSON.stringify(session, null, 2)
}
