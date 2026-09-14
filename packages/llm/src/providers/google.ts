import type { RouteDefaultsInput } from "../route/client"
import { Auth } from "../route/auth"
import type { ProviderAuthOption } from "../route/auth-options"
import { ProviderID, type ModelID, type ModelCompatibility } from "../schema"
import * as Gemini from "../protocols/gemini"

export const id = ProviderID.make("google")

export const routes = [Gemini.route]

export type Config = RouteDefaultsInput & ProviderAuthOption<"optional"> & { readonly baseURL?: string }

const auth = (options: ProviderAuthOption<"optional">) => {
  if ("auth" in options && options.auth) return options.auth
  return Auth.optional("apiKey" in options ? options.apiKey : undefined, "apiKey")
    .orElse(Auth.config("GOOGLE_GENERATIVE_AI_API_KEY"))
    .pipe(Auth.header("x-goog-api-key"))
}

const configuredRoute = (input: Config) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return Gemini.route.with({ ...rest, endpoint: { baseURL }, auth: auth(input) })
}

export const configure = (input: Config = {}) => {
  const route = configuredRoute(input)
  return {
    id,
    model: (modelID: string | ModelID, compatibility?: ModelCompatibility.Input) =>
    route.model({ id: modelID, ...(compatibility !== undefined ? { compatibility } : {}) }),
    configure,
  }
}

export const provider = configure()
export const model = provider.model
