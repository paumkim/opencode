import { describe, expect, test } from "bun:test"
import { ProviderIdentity } from "@opencode-ai/core/installation/provider-identity"
import { PINNED_KILO_VERSION, PINNED_VERSION, formatVersionStamp, normalizeVersion } from "../src/util/version-stamp"
import { familyForProvider, versionForSync } from "../src/util/provider-versions"

describe("TUI version stamp", () => {
  test("pinned fallbacks come from the shared identity table", () => {
    // The point of the refactor: the TUI no longer keeps its own copy of these
    // numbers, so it cannot drift from what a provider is told.
    expect(PINNED_VERSION).toBe(ProviderIdentity.IDENTITIES.opencode.pinned)
    expect(PINNED_KILO_VERSION).toBe(ProviderIdentity.IDENTITIES.kilo.pinned)
  })

  test("normalizeVersion rejects dev stamps and falls back to a real release", () => {
    expect(normalizeVersion("1.18.32")).toBe("1.18.32")
    expect(normalizeVersion("v1.18.32")).toBe("1.18.32")
    expect(normalizeVersion("0.0.0-dev-202609260139")).toBe(PINNED_VERSION)
    expect(normalizeVersion("local")).toBe(PINNED_VERSION)
    expect(normalizeVersion(undefined)).toBe(PINNED_VERSION)
  })

  test("each family renders its own version, never a dev stamp", () => {
    // A dev build must not reach the footer, and kilo must show kilo's own
    // version. The resolved value may be a live registry version that is newer
    // than the pinned fallback, so assert on validity and family, not equality
    // with the pinned number.
    const resolved = versionForSync("kilo", "0.0.0-dev-202609260139")
    expect(ProviderIdentity.isReleaseVersion(resolved)).toBe(true)
    expect(resolved).not.toContain("0.0.0")

    const stamp = formatVersionStamp({ version: resolved, providerID: "kilo" })
    expect(stamp).toContain(resolved)
    expect(stamp).toContain("kilo")
    expect(stamp).not.toContain("0.0.0")
  })

  test("the displayed version matches the version sent on the wire", () => {
    // The regression this whole change exists to prevent: footer said one
    // thing, the User-Agent said another. Compare the version numbers, since
    // the stamp also carries a provider suffix the User-Agent expresses as a
    // product token instead.
    for (const providerID of ["opencode", "opencode-zen", "kilo", "anthropic"]) {
      const family = familyForProvider(providerID)
      const displayed = normalizeVersion(versionForSync(family))
      const wire = ProviderIdentity.userAgentFor(providerID)

      expect(wire).toContain(displayed)
      expect(displayed).not.toContain("0.0.0")
      // And the product token the provider is addressed with is the one the
      // family declares, not opencode's, unless the family really is opencode.
      const expectedProduct = ProviderIdentity.IDENTITIES[family].product
      expect(wire.startsWith(`${expectedProduct}/`)).toBe(true)
    }
  })

  test("console-managed providers are shown with their provider suffix", () => {
    expect(
      formatVersionStamp({ version: "1.18.32", providerID: "some-zen", consoleManagedProviders: ["some-zen"] }),
    ).toBe("v1.18.32 • some-zen")
    expect(formatVersionStamp({ version: "1.18.32", providerID: "anthropic" })).toBe("v1.18.32")
  })
})
