import { describe, expect, test } from "bun:test"
import { defaultModelFromConfig, loadDirectorySnapshot } from "@/acp/service"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"

// The config read in the ACP directory load used to end in `.catch(() => undefined)`, while the
// provider, agent, command and skill reads beside it all rejected. `defaultModelFromConfig` cannot
// tell `undefined` from "this project configures no model", so a failed read fell through to the
// opencode provider and then to the best model overall: the editor integration was handed a guessed
// default as though the project had specified it, with nothing saying the configured answer was
// lost. The fallbacks themselves are deliberate and stay — a project that genuinely configures no
// model still gets a deterministic default.

const model = (providerID: string, id: string): Provider.Model =>
  ({
    id: ModelV2.ID.make(id),
    providerID,
    api: { id, url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
    name: id,
    family: "test",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, reasoning: false, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 4096 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }) as unknown as Provider.Model

const OPENCODE = ProviderV2.ID.make("opencode")
const CONFIGURED_PROVIDER = ProviderV2.ID.make("acme")
const providers = {
  [OPENCODE]: {
    id: OPENCODE,
    name: "opencode",
    source: "builtin",
    env: [],
    options: {},
    models: { "zen-1": model("opencode", "zen-1") },
  },
  [CONFIGURED_PROVIDER]: {
    id: CONFIGURED_PROVIDER,
    name: "acme",
    source: "config",
    env: [],
    options: {},
    models: { chosen: model("acme", "chosen") },
  },
} as unknown as Record<ProviderV2.ID, Provider.Info>

const ok = <T>(data: T) => ({ data }) as { data: T }
const rejected = (error: unknown) => Promise.reject(error)

const sdk = (config: () => Promise<unknown>) =>
  ({
    config: {
      providers: () => Promise.resolve(ok({ providers: [providers[OPENCODE], providers[CONFIGURED_PROVIDER]] })),
      get: config,
    },
    app: {
      agents: () => Promise.resolve(ok([{ name: "build", mode: "primary" }])),
      skills: () => Promise.resolve(ok([])),
    },
    command: { list: () => Promise.resolve(ok([])) },
  }) as unknown as OpencodeClient

describe("loadDirectorySnapshot default model", () => {
  test("uses the configured model when the config read succeeds", async () => {
    const snapshot = await loadDirectorySnapshot(
      sdk(() => Promise.resolve(ok({ model: "acme/chosen" }))),
      "/tmp/d",
    )
    expect(snapshot.defaultModel).toEqual({ providerID: CONFIGURED_PROVIDER, modelID: ModelV2.ID.make("chosen") })
  })

  test("still falls back deterministically when the project configures no model", async () => {
    // The documented fallback chain is preserved: configured model, then opencode provider, then the
    // best model. This is a real answer, not a failure being disguised.
    const snapshot = await loadDirectorySnapshot(
      sdk(() => Promise.resolve(ok({}))),
      "/tmp/d",
    )
    expect(snapshot.defaultModel).toEqual({ providerID: OPENCODE, modelID: ModelV2.ID.make("zen-1") })
  })

  test("reports a failed config read instead of substituting a guessed default model", async () => {
    // The regression: this resolved to the opencode fallback as though the project had chosen it.
    await expect(
      loadDirectorySnapshot(
        sdk(() => rejected(new Error("config unavailable"))),
        "/tmp/d",
      ),
    ).rejects.toThrow("config unavailable")
  })
})

describe("defaultModelFromConfig", () => {
  test("prefers the configured model", () => {
    expect(defaultModelFromConfig("acme/chosen", providers)).toEqual({
      providerID: CONFIGURED_PROVIDER,
      modelID: ModelV2.ID.make("chosen"),
    })
  })

  test("falls back to the opencode provider when nothing is configured", () => {
    expect(defaultModelFromConfig(undefined, providers)).toEqual({
      providerID: OPENCODE,
      modelID: ModelV2.ID.make("zen-1"),
    })
  })

  test("falls back to the best model when there is no opencode provider", () => {
    const only = { [CONFIGURED_PROVIDER]: providers[CONFIGURED_PROVIDER] } as Record<ProviderV2.ID, Provider.Info>
    expect(defaultModelFromConfig(undefined, only)).toEqual({
      providerID: CONFIGURED_PROVIDER,
      modelID: ModelV2.ID.make("chosen"),
    })
  })

  test("returns nothing when there are no providers at all", () => {
    expect(defaultModelFromConfig(undefined, {} as Record<ProviderV2.ID, Provider.Info>)).toBeUndefined()
  })
})
