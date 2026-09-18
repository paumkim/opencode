import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Deliberately separate from InstallationVersion and all compatibility checks.
declare const OPENCODE_INTERNAL_VERSION: string

export const InternalVersionFile = fileURLToPath(new URL("../../../../INTERNAL_VERSION", import.meta.url))

export function validateInternalVersion(value: string) {
  const version = value.trim()
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("INTERNAL_VERSION must be a plain major.minor.patch version")
  }
  if (!version.split(".").every((part) => Number.isSafeInteger(Number(part)))) {
    throw new Error("INTERNAL_VERSION components must be safe integers")
  }
  return version
}

export function bumpInternalVersion(value: string, bump: string) {
  const parts = validateInternalVersion(value).split(".").map(Number)
  const index = ["major", "minor", "patch"].indexOf(bump)
  if (index === -1) throw new Error("Internal version bump must be patch, minor, or major")
  return validateInternalVersion(parts.map((part, i) => (i < index ? part : i === index ? part + 1 : 0)).join("."))
}

export function readInternalVersion(root = path.dirname(InternalVersionFile)) {
  const version = validateInternalVersion(readFileSync(path.join(root, "INTERNAL_VERSION"), "utf8"))
  // Archives can live inside unrelated repositories; never use an ancestor's Git metadata.
  if (!existsSync(path.join(root, ".git"))) return `${version}+unknown`
  const sha = spawnSync("git", ["-C", root, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" })
  if (sha.status !== 0 || !/^[a-f0-9]{12,64}$/.test(sha.stdout.trim())) return `${version}+unknown`
  const status = spawnSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=normal"], {
    encoding: "utf8",
  })
  const suffix = status.status !== 0 ? ".unknown" : status.stdout.trim() ? ".dirty" : ""
  return `${version}+${sha.stdout.trim()}${suffix}`
}

export function internalVersion() {
  // Builds capture the source checkout once; never inspect the user's cwd at runtime.
  return typeof OPENCODE_INTERNAL_VERSION === "string" ? OPENCODE_INTERNAL_VERSION : readInternalVersion()
}
