import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))

declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export const PINNED_VERSION = "1.18.32"

function readPackageVersion(): string {
  // Pinned release — single source survives rebuilds without OPENCODE_VERSION.
  // Tries packages/opencode/package.json (1.18.32), never stale "local".
  const candidates = [
    join(__dirname, "..", "..", "..", "opencode", "package.json"),
    join(__dirname, "..", "..", "package.json"),
  ]
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8"))
      if (typeof pkg.version === "string" && !pkg.version.startsWith("0.0.0-")) return pkg.version
    } catch {}
  }
  return PINNED_VERSION
}

/**
 * The version of the console app this build ships with, if it ships with one.
 *
 * A packaged binary has no repo to read, so the lookup fails and this stays undefined rather than
 * reporting a made-up version. `undefined` is therefore the normal case for an end-user install and
 * must stay harmless everywhere it is used.
 */
function readConsoleVersion(): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "..", "..", "packages", "console", "app", "package.json"), "utf8"),
    )
    return typeof pkg.version === "string" ? pkg.version : undefined
  } catch {
    return undefined
  }
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : readPackageVersion()
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
export const ConsoleVersion = readConsoleVersion()

/**
 * The ` console/<version>` segment of a User-Agent, or the empty string when there is no console.
 *
 * One constant rather than the same conditional repeated at each header site: the whole point is that
 * an absent console leaves the header byte-for-byte what it was before, and that is a rule about the
 * segment, not about each caller.
 */
export const ConsoleAgentSegment = ConsoleVersion ? ` console/${ConsoleVersion}` : ""
