import { Config } from "@/config/config"
import { emptyConsoleState } from "@opencode-ai/core/v1/config/console-state"
import { Effect, Layer } from "effect"

export function make(overrides: Partial<Config.Interface> = {}) {
  return Config.Service.of({
    get: () => Effect.succeed({}),
    getGlobal: () => Effect.succeed({}),
    getOverlay: () => Effect.succeed({
      scope: "global",
      effective: {},
      global: {},
      project: {},
      targets: {
        global: { scope: "global", path: "", revision: "", exists: false, raw: {} },
        project: { scope: "project", path: "", revision: "", exists: false, raw: {} },
        active: { scope: "global", path: "", revision: "", exists: false, raw: {} },
      },
    }),
    updateOverlay: () => Effect.succeed({ overlay: {
      scope: "global",
      effective: {},
      global: {},
      project: {},
      targets: {
        global: { scope: "global", path: "", revision: "", exists: false, raw: {} },
        project: { scope: "project", path: "", revision: "", exists: false, raw: {} },
        active: { scope: "global", path: "", revision: "", exists: false, raw: {} },
      },
    }, changed: false }),
    getConsoleState: () => Effect.succeed(emptyConsoleState),
    update: () => Effect.void,
    updateGlobal: (config) => Effect.succeed({ info: config, changed: false }),
    invalidate: () => Effect.void,
    directories: () => Effect.succeed([]),
    waitForDependencies: () => Effect.void,
    ...overrides,
  })
}

export function layer(overrides?: Partial<Config.Interface>) {
  return Layer.succeed(Config.Service, make(overrides))
}

export * as TestConfig from "./config"
