import { describe, expect, test } from "bun:test"
import { ProviderIdentity } from "@opencode-ai/core/installation/provider-identity"

describe("ProviderIdentity", () => {
  describe("version validity", () => {
    test("accepts real release versions", () => {
      for (const value of ["1.18.32", "v1.18.32", "7.7.9", " 1.2.3 "]) {
        expect(ProviderIdentity.isReleaseVersion(value)).toBe(true)
      }
    })

    test("rejects dev, preview and local stamps", () => {
      // These are exactly the values a preview build or an unbuilt checkout
      // produces. None of them may ever reach a provider.
      for (const value of ["0.0.0-dev-202609260139", "0.0.0-local-20260101", "local", "", "   ", "abc"]) {
        expect(ProviderIdentity.isReleaseVersion(value)).toBe(false)
      }
    })

    test("normalize strips the v prefix and rejects unusable values", () => {
      expect(ProviderIdentity.normalize("v1.18.32")).toBe("1.18.32")
      expect(ProviderIdentity.normalize("0.0.0-dev-20260926")).toBeUndefined()
      expect(ProviderIdentity.normalize(undefined)).toBeUndefined()
    })
  })

  describe("family resolution", () => {
    test("routes each provider to the family that owns its identity", () => {
      expect(ProviderIdentity.familyForProvider("opencode")).toBe("opencode")
      expect(ProviderIdentity.familyForProvider("opencode-zen")).toBe("opencode")
      expect(ProviderIdentity.familyForProvider("kilo")).toBe("kilo")
      expect(ProviderIdentity.familyForProvider("kilocode")).toBe("kilo")
      expect(ProviderIdentity.familyForProvider("kilo-something")).toBe("kilo")
      expect(ProviderIdentity.familyForProvider("devin")).toBe("devin")
      expect(ProviderIdentity.familyForProvider("anthropic")).toBe("generic")
      expect(ProviderIdentity.familyForProvider(undefined)).toBe("generic")
    })

    test("console-managed providers are treated as first-party opencode", () => {
      expect(ProviderIdentity.familyForProvider("some-zen-alias", ["some-zen-alias"])).toBe("opencode")
      expect(ProviderIdentity.familyForProvider("other", new Set(["other"]))).toBe("opencode")
    })
  })

  describe("user agent", () => {
    test("addresses each family with its own product token and version", () => {
      // The whole point: a provider that runs its own models must not be told
      // it is talking to an opencode client of some other version.
      const kilo = ProviderIdentity.userAgentFor("kilo")
      const opencode = ProviderIdentity.userAgentFor("opencode")

      expect(kilo.startsWith("kilocode/")).toBe(true)
      expect(opencode.startsWith("opencode/")).toBe(true)
      expect(kilo).not.toBe(opencode)
    })

    test("appends a gateway tag and platform suffix when asked", () => {
      const ua = ProviderIdentity.userAgentFor("opencode", {
        tag: "cloudflare-ai-gateway",
        platform: true,
      })
      expect(ua).toContain("cloudflare-ai-gateway")
      expect(ua).toMatch(/\(.+ .+; .+\)/)
    })
  })

  describe("dev builds never leak a stamp", () => {
    test("a preview build version is replaced by a real release", () => {
      // Simulates the bug that shipped: a binary built without OPENCODE_VERSION
      // reported 0.0.0-dev-<ts> and put exactly that on the wire.
      const resolved = ProviderIdentity.versionForSync("opencode", "0.0.0-dev-202609260139")
      expect(ProviderIdentity.isReleaseVersion(resolved)).toBe(true)
      expect(resolved.startsWith("0.0.0-")).toBe(false)
    })

    test("an unbuilt 'local' version is replaced by a real release", () => {
      const resolved = ProviderIdentity.versionForSync("generic", "local")
      expect(ProviderIdentity.isReleaseVersion(resolved)).toBe(true)
    })

    test("the user agent never contains a dev stamp even for a dev build", () => {
      const resolved = ProviderIdentity.versionForSync("opencode", "0.0.0-dev-202609260139")
      expect(resolved).not.toContain("0.0.0-dev")
      expect(ProviderIdentity.userAgentFor("opencode")).not.toContain("0.0.0")
    })

    test("a valid build version is used as-is", () => {
      expect(ProviderIdentity.versionForSync("opencode", "1.18.32")).toBe("1.18.32")
    })
  })

  describe("client identity", () => {
    test("exposes the client token each provider expects", () => {
      expect(ProviderIdentity.clientFor("opencode")).toBe("opencode")
      expect(ProviderIdentity.clientFor("kilo")).toBe("kilocode")
      expect(ProviderIdentity.clientFor("devin")).toBe("devin-cli")
      expect(ProviderIdentity.clientFor("anthropic")).toBe("opencode")
    })
  })

  test("every family resolves to a usable release version", () => {
    for (const [family, version] of Object.entries(ProviderIdentity.snapshot())) {
      expect(ProviderIdentity.isReleaseVersion(version)).toBe(true)
      expect(Object.keys(ProviderIdentity.IDENTITIES)).toContain(family)
    }
  })
})
