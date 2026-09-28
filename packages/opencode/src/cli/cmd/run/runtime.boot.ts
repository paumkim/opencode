// Boot-time resolution for direct interactive mode.
//
// These functions run concurrently at startup to gather everything the runtime
// needs before the first frame: TUI keymap config, diff display style,
// model variant list with context limits, and session history for the prompt
// history ring. All are async because they read config or hit the SDK, but
// none block each other.
import { Context, Effect, Layer } from "effect"
import { resolve } from "@opencode-ai/tui/config"
import { TuiConfig } from "@/config/tui"
import { makeRuntime } from "@/effect/run-service"
import { reusePendingTask } from "./runtime.shared"
import { resolveSession, sessionHistory } from "./session.shared"
import type { RunDiffStyle, RunInput, RunPrompt, RunProvider, RunTuiConfig } from "./types"
import { pickVariant } from "./variant.shared"

export type ModelInfo = {
  providers: RunProvider[]
  variants: string[]
  limits: Record<string, number>
}

export type SessionInfo = {
  first: boolean
  history: RunPrompt[]
  variant: string | undefined
}

type Config = Awaited<ReturnType<typeof TuiConfig.get>>
type BootService = {
  readonly resolveModelInfo: (
    sdk: RunInput["sdk"],
    directory: string,
    model: RunInput["model"],
  ) => Effect.Effect<ModelInfo>
  readonly resolveSessionInfo: (
    sdk: RunInput["sdk"],
    sessionID: string,
    model: RunInput["model"],
  ) => Effect.Effect<SessionInfo>
  readonly resolveRunTuiConfig: () => Effect.Effect<RunTuiConfig>
  readonly resolveDiffStyle: () => Effect.Effect<RunDiffStyle>
}

const configTask: { current?: Promise<Config> } = {}

class Service extends Context.Service<Service, BootService>()("@opencode/RunBoot") {}

function loadConfig() {
  return reusePendingTask(configTask, () => TuiConfig.get())
}

function emptyModelInfo(): ModelInfo {
  return {
    providers: [],
    variants: [],
    limits: {},
  }
}

function emptySessionInfo(): SessionInfo {
  return {
    first: true,
    history: [],
    variant: undefined,
  }
}

function defaultRunTuiConfig(): RunTuiConfig {
  return {
    ...resolve({}, { terminalSuspend: process.platform !== "win32" }),
    diff_style: "auto",
  }
}

function runTuiConfig(config: Config | undefined): RunTuiConfig {
  if (!config) {
    return defaultRunTuiConfig()
  }

  return {
    keybinds: config.keybinds,
    leader_timeout: config.leader_timeout,
    diff_style: config.diff_style ?? "auto",
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = Effect.fn("RunBoot.config")(() => Effect.promise(() => loadConfig().catch(() => undefined)))

    const resolveModelInfo = Effect.fn("RunBoot.resolveModelInfo")(function* (
      sdk: RunInput["sdk"],
      directory: string,
      model: RunInput["model"],
    ) {
      // `config.providers` is the primary source and `provider.list()` the
      // fallback, so a failure of the first is not itself fatal — that is what
      // the fallback is for, and it must keep working. But when the second
      // fails too there is no data *and* a real error, and the old `?? []`
      // claimed the user has no models. That reads as broken auth or a broken
      // install rather than as the transient read failure it is, and a user who
      // pinned a model also lost every variant, because `info` is looked up in
      // the empty list.
      const connected = yield* Effect.promise(() =>
        sdk.config
          .providers({ directory })
          .then((item) => ({ data: item.data?.providers, failed: false }))
          .catch(() => ({ data: undefined, failed: true })),
      )
      const providers =
        connected.data !== undefined
          ? connected.data
          : yield* Effect.promise(() =>
              sdk.provider
                .list()
                .then((item) => item.data?.all)
                .catch(() => undefined),
            )
      if (providers === undefined) {
        return yield* Effect.die(
          new Error(
            `could not read the provider list for ${directory}: config.providers${
              connected.failed ? " and provider.list both failed" : " returned no data"
            }, so the model list is unknown rather than empty`,
          ),
        )
      }
      const limits = Object.fromEntries(
        providers.flatMap((provider) =>
          Object.entries(provider.models ?? {}).flatMap(([modelID, info]) => {
            const limit = info?.limit?.context
            if (typeof limit !== "number" || limit <= 0) {
              return []
            }

            return [[`${provider.id}/${modelID}`, limit] as const]
          }),
        ),
      )

      if (!model) {
        return {
          providers,
          variants: [],
          limits,
        }
      }

      const info = providers.find((item) => item.id === model.providerID)?.models?.[model.modelID]
      return {
        providers,
        variants: Object.keys(info?.variants ?? {}),
        limits,
      }
    })

    const resolveSessionInfo = Effect.fn("RunBoot.resolveSessionInfo")(function* (
      sdk: RunInput["sdk"],
      sessionID: string,
      model: RunInput["model"],
    ) {
      // No catch: a session that could not be read is not an empty session.
      // Collapsing it to `emptySessionInfo()` claimed `first: true`, and
      // `shown: !session.first` then hid the history entirely, so a transient
      // read error made `--resume` present a blank conversation that looked
      // exactly like a new one. The caller's `catch` already turns a rejection
      // into a clean `dieInteractive`, which is the right outcome for a user
      // who explicitly asked to resume a particular session.
      const session = yield* Effect.promise(() => resolveSession(sdk, sessionID))
      return {
        first: session.first,
        history: sessionHistory(session),
        variant: pickVariant(model, session),
      }
    })

    const resolveRunTuiConfig = Effect.fn("RunBoot.resolveRunTuiConfig")(function* () {
      return runTuiConfig(yield* config())
    })

    const resolveDiffStyle = Effect.fn("RunBoot.resolveDiffStyle")(function* () {
      return runTuiConfig(yield* config()).diff_style ?? "auto"
    })

    return Service.of({
      resolveModelInfo,
      resolveSessionInfo,
      resolveRunTuiConfig,
      resolveDiffStyle,
    })
  }),
)

const runtime = makeRuntime(Service, layer)

// Fetches available variants and context limits for every provider/model pair.
export async function resolveModelInfo(
  sdk: RunInput["sdk"],
  directory: string,
  model: RunInput["model"],
): Promise<ModelInfo> {
  // No catch: see the reasoning in the resolver above. `provider.list()`
  // defaults are the one place a fabricated empty value is defensible, and it
  // is not here.
  return runtime.runPromise((svc) => svc.resolveModelInfo(sdk, directory, model))
}

// Fetches session messages to determine if this is the first turn and build prompt history.
export async function resolveSessionInfo(
  sdk: RunInput["sdk"],
  sessionID: string,
  model: RunInput["model"],
): Promise<SessionInfo> {
  // Same reasoning as the Effect-side resolver: unlike `resolveRunTuiConfig`
  // and `resolveDiffStyle`, whose fallbacks are display preferences where
  // losing the value costs nothing, this fallback is a factual claim that the
  // session is new and has no history. It must not be made up on failure.
  return runtime.runPromise((svc) => svc.resolveSessionInfo(sdk, sessionID, model))
}

// Reads TUI config once for direct mode keymap setup and display preferences.
export async function resolveRunTuiConfig(): Promise<RunTuiConfig> {
  return runtime.runPromise((svc) => svc.resolveRunTuiConfig()).catch(() => defaultRunTuiConfig())
}

export async function resolveDiffStyle(): Promise<RunDiffStyle> {
  return runtime.runPromise((svc) => svc.resolveDiffStyle()).catch(() => "auto")
}
