// Display formatting for the version stamp shown in the TUI.
// Fast: pure + sync, no fetch, safe to call in a render getter.
//
// Version resolution lives in @opencode-ai/core/installation/provider-identity,
// which is also what builds the outbound User-Agent, so the footer and the wire
// cannot disagree. This file only decides how a resolved version is rendered.
import { ProviderIdentity } from "@opencode-ai/core/installation/provider-identity"

export const PINNED_VERSION = ProviderIdentity.IDENTITIES.opencode.pinned
export const PINNED_KILO_VERSION = ProviderIdentity.IDENTITIES.kilo.pinned

export function normalizeVersion(raw: unknown): string {
  // Reject dev/preview stamps so the footer never reverts to generic, using the
  // same guard the wire uses. e.g. "0.0.0-dev-...", "local", "" -> pinned release.
  return ProviderIdentity.normalize(raw) ?? PINNED_VERSION
}

export function isConsoleProvider(
  providerID: string | undefined,
  consoleManaged: readonly string[] | ReadonlySet<string> | undefined,
): boolean {
  if (!providerID) return false
  // opencode zen family: "opencode", "opencode-zen", "opencode/..." etc.
  if (providerID === "opencode" || providerID.startsWith("opencode")) return true
  if (!consoleManaged) return false
  if (Array.isArray(consoleManaged)) return consoleManaged.includes(providerID)
  return (consoleManaged as ReadonlySet<string>).has(providerID)
}

export function isKiloProvider(providerID: string | undefined): boolean {
  if (!providerID) return false
  const id = providerID.toLowerCase()
  return id === "kilo" || id === "kilocode" || id.startsWith("kilo")
}

export function formatVersionStamp(input: {
  version: unknown
  providerID?: string
  consoleManagedProviders?: readonly string[] | ReadonlySet<string>
}): string {
  const v = normalizeVersion(input.version)
  // Provider check BEFORE sending: each family gets ONLY its own console.
  // zen/opencode -> opencode console, kilo -> kilo console, else plain version.
  if (isKiloProvider(input.providerID)) {
    return `v${v} • ${input.providerID}`
  }
  if (isConsoleProvider(input.providerID, input.consoleManagedProviders)) {
    return `v${v} • ${input.providerID}`
  }
  return `v${v}`
}
