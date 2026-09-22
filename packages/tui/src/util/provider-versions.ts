// Per-provider live versions: instant sync read + background daily refresh.
// KV (kv.json in state dir) survives rebuilds; pinned fallbacks keep first paint fast.
// Sources: npm registry `opencode-ai/latest` and `@kilocode/cli/latest`.
export type ProviderFamily = "opencode" | "kilo" | "generic"

export const PINNED: Record<ProviderFamily, string> = {
  opencode: "1.18.32",
  kilo: "7.7.6",
  generic: "1.18.32",
}

const REGISTRY: Record<ProviderFamily, string> = {
  opencode: "https://registry.npmjs.org/opencode-ai/latest",
  kilo: "https://registry.npmjs.org/@kilocode%2Fcli/latest",
  generic: "https://registry.npmjs.org/opencode-ai/latest",
}

export const DAY_MS = 24 * 60 * 60 * 1000
export const cacheKey = (family: ProviderFamily) => `provider_version_${family}`

export type VersionCacheEntry = { version: string; checkedAt: number }

export function familyForProvider(
  providerID: string | undefined,
  consoleManaged?: readonly string[] | ReadonlySet<string>,
): ProviderFamily {
  if (!providerID) return "generic"
  const id = providerID.toLowerCase()
  if (id === "opencode" || id.startsWith("opencode")) return "opencode"
  if (id === "kilo" || id === "kilocode" || id.startsWith("kilo")) return "kilo"
  if (consoleManaged) {
    if (Array.isArray(consoleManaged)) {
      if (consoleManaged.includes(providerID)) return "opencode"
    } else if ((consoleManaged as ReadonlySet<string>).has(providerID)) return "opencode"
  }
  return "generic"
}

export function isValidVersion(v: unknown): v is string {
  return typeof v === "string" && /^\d+\.\d+\.\d+/.test(v.trim().replace(/^v/, ""))
}

// Instant, sync, never blocks: KV cache -> pinned. No fetch here.
export function resolveCachedVersionSync(
  kvGet: (key: string, fallback?: unknown) => unknown,
  family: ProviderFamily,
  buildVersion: unknown,
): string {
  try {
    const cached = kvGet(cacheKey(family)) as VersionCacheEntry | undefined
    if (cached && isValidVersion(cached.version)) return cached.version.trim().replace(/^v/, "")
  } catch {}
  if (family === "kilo") return PINNED.kilo
  if (typeof buildVersion === "string" && isValidVersion(buildVersion)) {
    return buildVersion.trim().replace(/^v/, "")
  }
  return PINNED[family] ?? PINNED.generic
}

export function shouldRefresh(entry: unknown, now = Date.now()): boolean {
  if (!entry || typeof entry !== "object") return true
  const checkedAt = (entry as VersionCacheEntry).checkedAt
  const version = (entry as VersionCacheEntry).version
  if (!isValidVersion(version)) return true
  if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) return true
  return now - checkedAt >= DAY_MS
}

export async function fetchLatest(family: ProviderFamily, timeoutMs = 3500): Promise<string | undefined> {
  const url = REGISTRY[family]
  if (!url) return undefined
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, { signal: ctrl.signal })
      if (!res.ok) return undefined
      const data = (await res.json()) as { version?: unknown }
      if (isValidVersion(data.version)) return (data.version as string).trim().replace(/^v/, "")
      return undefined
    } finally {
      clearTimeout(t)
    }
  } catch {
    return undefined
  }
}

let inflight: Promise<void> | undefined
// Background: first boot + at most once/day per family. Fire-and-forget, never throws.
export function ensureProviderVersionsFresh(input: {
  kv: { get: (key: string, fallback?: unknown) => unknown; set: (key: string, value: unknown) => void }
  families?: ProviderFamily[]
  now?: number
}): Promise<void> {
  if (inflight) return inflight
  const families = input.families ?? (["opencode", "kilo"] as ProviderFamily[])
  const now = input.now ?? Date.now()
  inflight = (async () => {
    await Promise.allSettled(
      families.map(async (family) => {
        let entry: unknown
        try {
          entry = input.kv.get(cacheKey(family))
        } catch {
          entry = undefined
        }
        if (!shouldRefresh(entry, now)) return
        const latest = await fetchLatest(family)
        try {
          if (latest) input.kv.set(cacheKey(family), { version: latest, checkedAt: Date.now() } satisfies VersionCacheEntry)
          else if (shouldRefresh(entry, now)) {
            // Record the attempt so we don't hammer the registry every boot when offline.
            const fallback = entry as VersionCacheEntry | undefined
            input.kv.set(
              cacheKey(family),
              { version: fallback && isValidVersion(fallback.version) ? fallback.version : PINNED[family], checkedAt: Date.now() } satisfies VersionCacheEntry,
            )
          }
        } catch {}
      }),
    )
  })().finally(() => {
    inflight = undefined
  })
  return inflight
}
