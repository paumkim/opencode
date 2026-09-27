import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { parse } from "./assertions"
import { runtime, type Runtime } from "./runtime"
import type { ActiveScenario, BackendApp, CallResult, CaptureMode, SeededContext } from "./types"

type CallOptions = {
  auth?: {
    password?: string
    username?: string
  }
}

export function call(scenario: ActiveScenario, ctx: SeededContext<unknown>, options: CallOptions = {}) {
  return Effect.promise(async () =>
    capture(await app(await runtime(), options).request(toRequest(scenario, ctx)), scenario.capture),
  )
}

export function callAuthProbe(scenario: ActiveScenario, credentials: "missing" | "valid" = "missing") {
  return Effect.promise(async () => {
    const controller = new AbortController()
    return Promise.race([
      Promise.resolve(
        app(await runtime(), { auth: { password: "secret" } }).request(
          toAuthProbeRequest(scenario, credentials, controller.signal),
        ),
      ).then((response) => capture(response, scenario.capture)),
      Bun.sleep(1_000).then(() => {
        controller.abort("auth probe timed out")
        return {
          status: 0,
          contentType: "",
          text: "auth probe timed out",
          body: undefined,
          timedOut: true,
        }
      }),
    ])
  })
}

type CachedApp = BackendApp & { readonly dispose: () => Promise<void> }

const appCache: Partial<Record<string, CachedApp>> = {}

// `app.dispose()` is `Effect.runPromise(Scope.close(...))` over the whole app layer, and that
// close intermittently blocks on a background fiber from the layer. Teardown must not decide
// the run's outcome: `disposeApps` is called after every mutating scenario (inside
// `Effect.promise`, which is uninterruptible, so even the 30s scenario timeout cannot rescue a
// stuck one) and again from the scope finalizer, where `Effect.scoped` waits for it before
// `process.exit` is reached. A wedged teardown therefore turned runs that had already printed
// `pass=209 fail=0 missing=0` into CI timeouts. Bound the wait here, at the operation that owns
// it, so both call sites are covered by one rule. Abandoning a stuck close is safe: the cache is
// emptied above before awaiting, so the next caller builds a fresh app. The warning keeps the
// stuck close visible instead of hiding it.
const disposeTimeoutMs = 30_000

export async function disposeApps() {
  const apps = Object.values(appCache)
  for (const key of Object.keys(appCache)) delete appCache[key]
  await Promise.all(
    apps.flatMap((app) => {
      if (app === undefined) return []
      let timer: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.error(
            `\x1b[33mwarning: app teardown did not finish within ${disposeTimeoutMs / 1000}s; continuing\x1b[0m`,
          )
          resolve()
        }, disposeTimeoutMs)
      })
      return [Promise.race([app.dispose().then(() => undefined), expired]).finally(() => clearTimeout(timer))]
    }),
  )
}

function app(modules: Runtime, options: CallOptions) {
  const username = options.auth?.username
  const password = options.auth?.password
  const cacheKey = `${username ?? ""}:${password ?? ""}`
  if (appCache[cacheKey]) return appCache[cacheKey]

  const web = HttpRouter.toWebHandler(
    modules.HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: username }),
        ),
      ),
    ),
    { disableLogger: true, memoMap: modules.memoMap },
  )
  return (appCache[cacheKey] = {
    dispose: web.dispose,
    request(input: string | URL | Request, init?: RequestInit) {
      return web.handler(
        input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
        modules.HttpApiApp.context,
      )
    },
  })
}

function toRequest(scenario: ActiveScenario, ctx: SeededContext<unknown>) {
  const spec = scenario.request(ctx, ctx.state)
  return new Request(new URL(spec.path, "http://localhost"), {
    method: scenario.method,
    headers: spec.body === undefined ? spec.headers : { "content-type": "application/json", ...spec.headers },
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
  })
}

function toAuthProbeRequest(scenario: ActiveScenario, credentials: "missing" | "valid", signal: AbortSignal) {
  const spec = scenario.authProbe ?? {
    path: authProbePath(scenario.path),
    body: scenario.method === "GET" ? undefined : {},
  }
  const headers = {
    ...(spec.body === undefined ? {} : { "content-type": "application/json" }),
    ...spec.headers,
    ...(credentials === "valid" ? { authorization: basic("opencode", "secret") } : {}),
  }
  return new Request(new URL(spec.path, "http://localhost"), {
    method: scenario.method,
    headers,
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
    signal,
  })
}

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function authProbePath(path: string) {
  return path
    .replace(/\{([^}]+)\}/g, (_match, key: string) => `auth_${key}`)
    .replace(/:([^/]+)/g, (_match, key: string) => `auth_${key}`)
}

async function capture(response: Response, mode: CaptureMode): Promise<CallResult> {
  const text = mode === "stream" ? await captureStream(response) : await response.text()
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text,
    body: parse(text),
    timedOut: false,
  }
}

async function captureStream(response: Response) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const read = reader.read().then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  )
  const winner = await Promise.race([read, Bun.sleep(1_000).then(() => ({ timeout: true }))])
  if ("timeout" in winner) {
    await reader.cancel("timed out waiting for stream chunk").catch(() => undefined)
    throw new Error("timed out waiting for stream chunk")
  }
  if ("error" in winner) throw winner.error
  await reader.cancel().catch(() => undefined)
  if (winner.result.done) return ""
  return new TextDecoder().decode(winner.result.value)
}
