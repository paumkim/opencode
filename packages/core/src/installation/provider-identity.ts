export * as ProviderIdentity from "./provider-identity"

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Global } from "../global"
import { InstallationVersion } from "./version"

/**
 * How opencode identifies itself, per provider family.
 *
 * This is the single source of truth for outbound identity. It exists because
 * the answer is genuinely not "the opencode version" for every provider: each
 * family has its own published client, its own version stream, and its own idea
 * of what a legitimate request looks like. Sending opencode's version to a
 * provider that expects its own client identity is how a request gets treated as
 * generic API traffic instead of first-party client traffic.
 *
 * The same table drives the version shown in the UI, so what is displayed and
 * what goes out on the wire cannot drift apart.
 */
export type ProviderFamily = "opencode" | "kilo" | "devin" | "generic"

export interface ProviderIdentity {
  /** Client token the provider expects to see, e.g. `opencode`, `kilocode`. */
  readonly client: string
  /** Prefix for the User-Agent product token. */
  readonly product: string
  /** Registry queried for the live version of this family's client. */
  readonly registry?: string
  /** Used when the registry is unreachable, or no build version is known. */
  readonly pinned: string
  /** Extra product token appended to the User-Agent, e.g. a gateway name. */
  readonly tag?: string
}

const OPENCODE_REGISTRY = "https://registry.npmjs.org/opencode-ai/latest"
const KILO_REGISTRY = "https://registry.npmjs.org/@kilocode%2Fcli/latest"
const DEVIN_REGISTRY = "https://registry.npmjs.org/@devin/cli/latest"

export const IDENTITIES: Record<ProviderFamily, ProviderIdentity> = {
  // opencode's own console / zen. This is the family whose version must match
  // the published opencode-ai release, because that is the version the backend
  // gates features on.
  opencode: { client: "opencode", product: "opencode", registry: OPENCODE_REGISTRY, pinned: "1.18.32" },
  // Kilo runs its own models and expects its own client identity and version.
  kilo: { client: "kilocode", product: "kilocode", registry: KILO_REGISTRY, pinned: "7.7.6" },
  // Devin gates the free SWE model behind CLI-shaped traffic.
  devin: { client: "devin-cli", product: "devin-cli", registry: DEVIN_REGISTRY, pinned: "1.0.0" },
  // Everything else: we are an opencode client talking to someone else's API.
  generic: { client: "opencode", product: "opencode", registry: OPENCODE_REGISTRY, pinned: "1.18.32" },
}

/**
 * A version is only usable on the wire if it is a real release number.
 *
 * A dev or preview build reports `0.0.0-<channel>-<timestamp>`, and an
 * unbuilt checkout can report `local`. Sending either upstream tells the
 * provider we are an unreleased build, which is both wrong and, in the case of
 * `local`, not a version at all. The UI has always masked these for display;
 * this is the same guard applied to the value we actually transmit.
 */
export function isReleaseVersion(value: unknown): value is string {
  if (typeof value !== "string") return false
  const trimmed = value.trim().replace(/^v/, "")
  if (!trimmed) return false
  if (trimmed === "local" || trimmed.startsWith("0.0.0-") || trimmed.startsWith("0.0.0_")) return false
  return /^\d+\.\d+\.\d+/.test(trimmed)
}

export function normalize(value: unknown): string | undefined {
  if (!isReleaseVersion(value)) return undefined
  return value.trim().replace(/^v/, "")
}

export function familyForProvider(
  providerID: string | undefined,
  consoleManaged?: readonly string[] | ReadonlySet<string>,
): ProviderFamily {
  if (!providerID) return "generic"
  const id = providerID.toLowerCase()
  if (id === "kilo" || id === "kilocode" || id.startsWith("kilo")) return "kilo"
  if (id === "devin" || id.startsWith("devin")) return "devin"
  if (id === "opencode" || id.startsWith("opencode")) return "opencode"
  if (consoleManaged) {
    if (Array.isArray(consoleManaged)) {
      if (consoleManaged.includes(providerID)) return "opencode"
    } else if ((consoleManaged as ReadonlySet<string>).has(providerID)) return "opencode"
  }
  return "generic"
}

// --- version cache ---------------------------------------------------------
// A single JSON file in the state dir, shared by every process and the UI.
// Read synchronously because header construction is on the hot path and must
// never await; refreshed in the background.

const CACHE_FILE = "provider-versions.json"
export const DAY_MS = 24 * 60 * 60 * 1000

interface CacheEntry {
  version: string
  checkedAt: number
}

type Cache = Partial<Record<ProviderFamily, CacheEntry>>

function cachePath() {
  return path.join(Global.Path.state, CACHE_FILE)
}

function readCache(): Cache {
  try {
    const file = cachePath()
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return typeof parsed === "object" && parsed !== null ? (parsed as Cache) : {}
  } catch {
    return {}
  }
}

function writeCache(cache: Cache) {
  try {
    writeFileSync(cachePath(), JSON.stringify(cache, null, 2))
  } catch {
    // A cache we cannot persist is still usable for this process.
  }
}

/**
 * Synchronous best-available version for a family: cache first, then the
 * identity's pinned release, then the compiled-in build version.
 *
 * Never returns a dev stamp, so a preview build cannot leak `0.0.0-dev-...`
 * to a provider even though that is what `--version` prints locally.
 */
export function versionForSync(family: ProviderFamily, buildVersion: unknown = InstallationVersion): string {
  const identity = IDENTITIES[family]
  const cached = readCache()[family]
  if (cached) {
    const normalized = normalize(cached.version)
    if (normalized) return normalized
  }
  // Only the opencode family may fall back to our own build version, and only
  // when it is a real release number. A dev build must not stand in for it.
  if (family === "opencode" || family === "generic") {
    const normalized = normalize(buildVersion)
    if (normalized) return normalized
  }
  return identity.pinned
}

/** Whether the cached entry for a family is absent or older than a day. */
export function needsRefresh(family: ProviderFamily, now = Date.now()): boolean {
  const cached = readCache()[family]
  if (!cached) return true
  if (!isReleaseVersion(cached.version)) return true
  if (typeof cached.checkedAt !== "number" || !Number.isFinite(cached.checkedAt)) return true
  return now - cached.checkedAt >= DAY_MS
}

/**
 * Refresh one family from its registry. Never throws: a failed lookup leaves
 * the previous cached value in place.
 */
export async function refresh(family: ProviderFamily, timeoutMs = 3500): Promise<string | undefined> {
  const identity = IDENTITIES[family]
  if (!identity.registry) return undefined
  try {
    const response = await fetch(identity.registry, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": `${identity.product}/${identity.pinned}` },
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { version?: unknown }
    const version = normalize(body?.version)
    if (!version) return undefined
    const cache = readCache()
    cache[family] = { version, checkedAt: Date.now() }
    writeCache(cache)
    return version
  } catch {
    return undefined
  }
}

/** Refresh every family that is due. Safe to call opportunistically. */
export async function refreshStale(): Promise<void> {
  await Promise.all(
    (Object.keys(IDENTITIES) as ProviderFamily[]).map((family) => (needsRefresh(family) ? refresh(family) : undefined)),
  )
}

export interface UserAgentOptions {
  /** Appended product token, e.g. `cloudflare-ai-gateway`. */
  readonly tag?: string
  /** Include the OS/arch suffix some providers expect. */
  readonly platform?: boolean
}

/**
 * The exact User-Agent to send a given provider.
 *
 * Each family gets its own product token and its own version. `opencode/<ver>`
 * is only used for families that genuinely are opencode clients.
 */
export function userAgentFor(
  providerID: string | undefined,
  options: UserAgentOptions & { consoleManaged?: readonly string[] | ReadonlySet<string> } = {},
): string {
  const family = familyForProvider(providerID, options.consoleManaged)
  const identity = IDENTITIES[family]
  const version = versionForSync(family)
  const parts = [`${identity.product}/${version}`]
  if (options.tag ?? identity.tag) parts.push(options.tag ?? identity.tag!)
  if (options.platform) parts.push(`(${os.platform()} ${os.release()}; ${os.arch()})`)
  return parts.join(" ")
}

/** Client token for a provider, for headers like `X-Client-Info`. */
export function clientFor(
  providerID: string | undefined,
  consoleManaged?: readonly string[] | ReadonlySet<string>,
): string {
  return IDENTITIES[familyForProvider(providerID, consoleManaged)].client
}

/** Every known family version, for display and diagnostics. */
export function snapshot(): Record<ProviderFamily, string> {
  return {
    opencode: versionForSync("opencode"),
    kilo: versionForSync("kilo"),
    devin: versionForSync("devin"),
    generic: versionForSync("generic"),
  }
}
