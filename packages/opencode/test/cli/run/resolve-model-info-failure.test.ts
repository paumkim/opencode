import { describe, expect, test } from "bun:test"
import { resolveModelInfo } from "@/cli/cmd/run/runtime.boot"
import type { RunInput } from "@/cli/cmd/run/types"

/**
 * Models the generated SDK client: a typed HTTP failure comes back as
 * `{ data: undefined, error }` on the *resolved* value rather than rejecting.
 * A stub that rejected would not have caught the original defect, because the
 * original defect was that `.error` was never read at all.
 */
function stubSdk(input: {
  providers?: { data?: { providers?: unknown[] }; error?: unknown }
  list?: { data?: { all?: unknown[] }; error?: unknown }
}) {
  const calls: string[] = []
  const resolve =
    <T>(value: T) =>
    async () =>
      value
  const sdk = {
    config: {
      providers: async () => {
        calls.push("config.providers")
        return input.providers ?? { data: undefined, error: { data: { message: "boom" } } }
      },
    },
    provider: {
      list: async () => {
        calls.push("provider.list")
        return input.list ?? { data: undefined, error: { data: { message: "boom" } } }
      },
    },
  }
  return { sdk: sdk as unknown as RunInput["sdk"], calls }
}

const model = { providerID: "anthropic", modelID: "claude" }
const dir = "/tmp/project"

function provider(id: string) {
  return { id, name: id, models: { m: { name: "m" } } }
}

describe("resolveModelInfo", () => {
  test("uses the primary read when it succeeds", async () => {
    const { sdk, calls } = stubSdk({ providers: { data: { providers: [provider("anthropic")] } } })
    const info = await resolveModelInfo(sdk, dir, model)
    expect(info.providers.map((p) => p.id)).toEqual(["anthropic"])
    expect(calls).toEqual(["config.providers"])
  })

  // The fallback must keep working: a server without config.providers is the
  // reason it exists, and turning its failure into a hard error would be a
  // regression, not a fix.
  test("falls back to provider.list when the primary read fails", async () => {
    const { sdk, calls } = stubSdk({ list: { data: { all: [provider("openai")] } } })
    const info = await resolveModelInfo(sdk, dir, model)
    expect(info.providers.map((p) => p.id)).toEqual(["openai"])
    expect(calls).toEqual(["config.providers", "provider.list"])
  })

  // The regression: both reads failing used to yield `[]`, which is
  // indistinguishable from "you have no models" and also wiped every variant
  // for a user who had pinned a model.
  test("rejects when both reads fail instead of reporting an empty list", async () => {
    const { sdk } = stubSdk({})
    await expect(resolveModelInfo(sdk, dir, model)).rejects.toThrow(/provider list/)
  })

  test("keeps a genuinely empty provider list as authoritative", async () => {
    const { sdk, calls } = stubSdk({ providers: { data: { providers: [] } } })
    const info = await resolveModelInfo(sdk, dir, model)
    expect(info.providers).toEqual([])
    // An empty-but-real answer must not trigger the fallback.
    expect(calls).toEqual(["config.providers"])
  })

  test("does not report variants for a model when the read failed", async () => {
    const { sdk } = stubSdk({})
    const variants = await resolveModelInfo(sdk, dir, model).then(
      (info) => info.variants,
      () => "rejected" as const,
    )
    expect(variants).not.toEqual([])
  })
})
