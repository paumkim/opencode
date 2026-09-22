import { Effect } from "effect"
import type { CustomDep, CustomLoader, Info, Model } from "../provider"
import { selectAzureLanguageModel } from "../provider"


export function azureCognitiveServices(dep: CustomDep): CustomLoader {
  return Effect.fnUntraced(function* (provider: Info) {
      const resourceName = yield* dep.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          return selectAzureLanguageModel(sdk, modelID, Boolean(options?.["useCompletionUrls"]))
        },
        options: {
          baseURL: resourceName
            ? `https://${resourceName}.cognitiveservices.azure.com/openai${provider.options?.useDeploymentBasedUrls ? "" : "/v1"}`
            : undefined,
        },
      }
    })
}
