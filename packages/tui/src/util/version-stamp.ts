// Single source of truth for the TUI version stamp.
// Fast: pure + sync, no fetch, safe to call in a render getter.
// Live versions come from provider-versions.ts KV cache (daily refresh);
// PINNED_* below are fallbacks only, never the display when cache exists.
export const PINNED_VERSION = "1.18.32"
export const PINNED_KILO_VERSION = "7.7.6"

export function normalizeVersion(raw: unknown): string {
  if (typeof raw !== "string") return PINNED_VERSION
  const v = raw.trim().replace(/^v/, "")
  // Reject dev/preview stamps so the footer never reverts to generic.
  // e.g. "0.0.0-dev-...", "0.0.0-", "local", "" -> pinned release.
  if (!v || v === "local" || v.startsWith("0.0.0-") || v.startsWith("0.0.0_")) return PINNED_VERSION
  return v
}

export function isConsoleProvider(providerID: string | undefined, consoleManaged: readonly string[] | ReadonlySet<string> | undefined): boolean {
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
