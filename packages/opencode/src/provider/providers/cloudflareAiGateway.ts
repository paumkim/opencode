import { Effect } from "effect"
import { iife } from "@/util/iife"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import os from "os"
import type { CustomDep, CustomLoader, Info, Model } from "../provider"


export function cloudflareAiGateway(dep: CustomDep): CustomLoader {
  return Effect.fnUntraced(function* (input: Info) {
      // When baseURL is already configured (e.g. corporate config), skip the ID checks.
      if (input.options?.baseURL) return { autoload: false }

      const auth = yield* dep.auth(input.id)
      const env = yield* dep.env()
      const accountId = env["CLOUDFLARE_ACCOUNT_ID"] || (auth?.type === "api" ? auth.metadata?.accountId : undefined)
      // The Cloudflare auth prompt stores this value as gatewayId metadata.
      const gateway = env["CLOUDFLARE_GATEWAY_ID"] || (auth?.type === "api" ? auth.metadata?.gatewayId : undefined)

      if (!accountId || !gateway) {
        const missing = [
          !accountId ? "CLOUDFLARE_ACCOUNT_ID" : undefined,
          !gateway ? "CLOUDFLARE_GATEWAY_ID" : undefined,
        ].filter((x): x is string => Boolean(x))
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              `${missing.join(" and ")} missing. Set with: ${missing.map((x) => `export ${x}=<value>`).join(" && ")}`,
            )
          },
        }
      }

      // Get API token from env or auth - required for authenticated gateways
      const apiToken =
        env["CLOUDFLARE_API_TOKEN"] || env["CF_AIG_TOKEN"] || (auth?.type === "api" ? auth.key : undefined)

      if (!apiToken) {
        throw new Error(
          "CLOUDFLARE_API_TOKEN (or CF_AIG_TOKEN) is required for Cloudflare AI Gateway. " +
            "Set it via environment variable or run `opencode auth cloudflare-ai-gateway`.",
        )
      }

      const { createAiGateway } = yield* Effect.promise(() => import("ai-gateway-provider"))
      const { createUnified } = yield* Effect.promise(() => import("ai-gateway-provider/providers/unified"))
      const { createOpenAI } = yield* Effect.promise(() => import("ai-gateway-provider/providers/openai"))
      const { createAnthropic } = yield* Effect.promise(() => import("ai-gateway-provider/providers/anthropic"))
      const { createOpenAICompatible } = yield* Effect.promise(() => import("@ai-sdk/openai-compatible"))

      const metadata = iife(() => {
        if (input.options?.metadata) return input.options.metadata
        try {
          return JSON.parse(input.options?.headers?.["cf-aig-metadata"])
        } catch {
          return undefined
        }
      })
      const opts = {
        metadata,
        cacheTtl: input.options?.cacheTtl,
        cacheKey: input.options?.cacheKey,
        skipCache: input.options?.skipCache,
        collectLog: input.options?.collectLog,
        headers: {
          "User-Agent": `opencode/${InstallationVersion} cloudflare-ai-gateway (${os.platform()} ${os.release()}; ${os.arch()})`,
          "X-BILLING-INVOKE-ORIGIN": "OpenCode",
        },
      }

      const aigateway = createAiGateway({
        accountId,
        gateway,
        apiKey: apiToken,
        ...(Object.values(opts).some((v) => v !== undefined) ? { options: opts } : {}),
      })
      return {
        autoload: true,
        async getModel(_sdk: any, modelID: string, _options?: Record<string, any>) {
          // Model IDs use Unified API format: provider/model (e.g., "anthropic/claude-sonnet-4-5").
          // OpenAI and Anthropic ride their native passthrough routes so agents get the Responses
          // and Messages APIs; new OpenAI models reject tools+reasoning_effort on chat completions.
          // The passthrough wrappers inject a CF_TEMP_TOKEN sentinel that the gateway strips before
          // dispatch, so upstream billing stays on the gateway (Unified Billing / stored BYOK).
          if (modelID.startsWith("openai/")) return aigateway(createOpenAI()(modelID.slice("openai/".length)))
          // models.dev lists Anthropic ids with dotted versions (claude-haiku-4.5); Anthropic's
          // Messages API expects dashed native slugs (claude-haiku-4-5), so translate before passing.
          // No native Anthropic slug contains a dot, so the blanket replacement is lossless here -
          // unlike OpenAI above, whose native ids (e.g. gpt-4.1) keep their dots and must not be touched.
          if (modelID.startsWith("anthropic/"))
            return aigateway(createAnthropic()(modelID.slice("anthropic/".length).replaceAll(".", "-")))
          // Workers AI is the only first-party provider whose upstream is Cloudflare itself, so it is
          // the only one that should receive the Cloudflare token as its upstream Authorization header.
          // The Unified API addresses Workers AI both with the explicit "workers-ai/" prefix and as
          // bare "@cf/..." ids. Third-party providers must not receive the token; they rely on the
          // gateway's stored/BYOK keys instead.
          // Workers AI is Cloudflare's own upstream, so it rides the unified compat route with the
          // Cloudflare token as its upstream Authorization header.
          const isWorkersAi = modelID.startsWith("workers-ai/") || modelID.startsWith("@cf/")
          if (isWorkersAi) return aigateway(createUnified({ apiKey: apiToken })(modelID))

          // Every other third-party provider (google, xai, alibaba, deepseek, moonshotai, …) is only
          // served by Cloudflare's catalog-aware REST API. The universal/compat gateway route rejects
          // them with "Invalid provider" (the gateway's compat endpoint doesn't front those upstreams),
          // so point an OpenAI-compatible client at the REST endpoint and bind it to the gateway with
          // cf-aig-gateway-id — that keeps requests gateway-routed (analytics/caching/BYOK), not a
          // bypass. models.dev ids (provider/model, dotted) pass through unchanged.
          return createOpenAICompatible({
            name: "cloudflare-ai-gateway",
            baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
            apiKey: apiToken,
            headers: { "cf-aig-gateway-id": gateway },
          })(modelID)
        },
        options: {},
      }
    })
}
