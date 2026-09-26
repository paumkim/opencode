import path from "path"
import { realpathSync } from "fs"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { FSUtil } from "@opencode-ai/core/fs-util"

type Kind = "file" | "directory"
type Options = { bypass?: boolean; kind?: Kind }

const canonicalPathEffect = Effect.fn("Tool.canonicalPath")(function* (target: string) {
  let candidate = path.resolve(target)
  const suffix: string[] = []
  while (true) {
    let resolved: { found: true; value: string } | { found: false; missing: boolean }
    try {
      resolved = { found: true, value: realpathSync.native(candidate) }
    } catch (error) {
      resolved = { found: false, missing: (error as { code?: string }).code === "ENOENT" }
    }
    if (resolved.found) {
      let result = resolved.value
      for (const part of suffix.reverse()) result = path.join(result, part)
      return result
    }
    if (!resolved.missing) return undefined
    const parent = path.dirname(candidate)
    if (parent === candidate) return undefined
    suffix.push(path.basename(candidate))
    candidate = parent
  }
})

export const containsCanonicalPathEffect = Effect.fn("Tool.containsCanonicalPath")(function* (target: string, instance: InstanceContext) {
  const canonicalTarget = yield* canonicalPathEffect(target)
  const canonicalDirectory = yield* canonicalPathEffect(instance.directory)
  const canonicalWorktree = instance.worktree === "/" ? undefined : yield* canonicalPathEffect(instance.worktree)
  if (!canonicalTarget || !canonicalDirectory) return false
  if (FSUtil.contains(canonicalDirectory, canonicalTarget)) return true
  return Boolean(canonicalWorktree && FSUtil.contains(canonicalWorktree, canonicalTarget))
})

export const canonicalDirectoryEffect = Effect.fn("Tool.canonicalDirectory")(function* (target: string, kind: Kind = "file") {
  const canonical = yield* canonicalPathEffect(target)
  if (!canonical) return
  return kind === "directory" ? canonical : path.dirname(canonical)
})

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (ctx: Tool.Context, target?: string, options?: Options) {
  if (!target || options?.bypass) return false
  const ins = yield* InstanceState.context
  const full = process.platform === "win32" ? FSUtil.normalizePath(target) : path.resolve(target)
  if (containsPath(full, ins) && (yield* containsCanonicalPathEffect(full, ins))) return false
  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const canonicalDir = yield* canonicalDirectoryEffect(full, kind)
  if (!canonicalDir) {
    yield* ctx.ask({ permission: "external_directory", patterns: [full], always: [full], metadata: { filepath: full, parentDir: dir } })
    return true
  }
  const glob = process.platform === "win32"
    ? FSUtil.normalizePathPattern(path.join(canonicalDir, "*"))
    : path.join(canonicalDir, "*").replaceAll("\\", "/")
  yield* ctx.ask({ permission: "external_directory", patterns: [glob], always: [glob], metadata: { filepath: full, parentDir: dir } })
  return true
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options))
}
