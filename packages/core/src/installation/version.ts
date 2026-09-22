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

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : readPackageVersion()
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
