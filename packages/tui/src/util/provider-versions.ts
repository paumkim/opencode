// Per-provider live versions for the TUI.
//
// The logic now lives in @opencode-ai/core/installation/provider-identity, which
// is the same table used to build the outbound User-Agent. That is the point:
// previously the TUI kept its own PINNED map, its own registry list and its own
// cache, so the version shown in the footer could drift from the version actually
// sent to a provider. One table, one cache, one answer.
//
// This module is kept as the TUI's import surface so call sites stay readable.
export {
  DAY_MS,
  IDENTITIES,
  familyForProvider,
  isReleaseVersion as isValidVersion,
  needsRefresh as shouldRefresh,
  normalize,
  refresh as fetchLatest,
  refreshStale as ensureProviderVersionsFresh,
  snapshot,
  userAgentFor,
  versionForSync,
} from "@opencode-ai/core/installation/provider-identity"

export type { ProviderFamily, ProviderIdentity } from "@opencode-ai/core/installation/provider-identity"
