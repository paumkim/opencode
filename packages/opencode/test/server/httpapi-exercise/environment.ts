import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect } from "effect"
import path from "path"

const preserveExerciseGlobalRoot = !!process.env.OPENCODE_HTTPAPI_EXERCISE_GLOBAL
export const exerciseGlobalRoot =
  process.env.OPENCODE_HTTPAPI_EXERCISE_GLOBAL ??
  path.join(process.env.TMPDIR ?? "/tmp", `opencode-httpapi-global-${process.pid}`)
process.env.XDG_DATA_HOME = path.join(exerciseGlobalRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(exerciseGlobalRoot, "config")
process.env.XDG_STATE_HOME = path.join(exerciseGlobalRoot, "state")
process.env.XDG_CACHE_HOME = path.join(exerciseGlobalRoot, "cache")
process.env.OPENCODE_DISABLE_SHARE = "true"
export const exerciseConfigDirectory = path.join(exerciseGlobalRoot, "config", "opencode")
export const exerciseDataDirectory = path.join(exerciseGlobalRoot, "data", "opencode")

const preserveExerciseDatabase = !!process.env.OPENCODE_HTTPAPI_EXERCISE_DB
export const exerciseDatabasePath =
  process.env.OPENCODE_HTTPAPI_EXERCISE_DB ??
  path.join(process.env.TMPDIR ?? "/tmp", `opencode-httpapi-exercise-${process.pid}.db`)
process.env.OPENCODE_DB = exerciseDatabasePath
Flag.OPENCODE_DB = exerciseDatabasePath

export const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
}

// This harness runs as a plain `bun run script/httpapi-exercise.ts`, so bunfig.toml's
// `[test] preload` (./test/preload.ts) never loads. That preload deletes the shell-profile
// variables that would otherwise decide the results of a run; as a sibling harness the
// exerciser needs the same isolation, which is why the deletions live here next to the
// XDG/OPENCODE_DB redirection above.
//
// OPENCODE_UNRESTRICTED is read at call time by `PermissionV2.ask`/`assert`
// (packages/core/src/permission.ts) and by `Permission.ask`; when it is "1" every
// permission check is bypassed, so a request that should queue a pending "ask" resolves
// to "allow" with nothing registered. OPENCODE_API_KEY is treated by
// `packages/core/src/plugin/provider/opencode.ts` as "a key is configured", which keeps
// the real key and leaves paid models enabled instead of pinning the provider to "public".
// Both are routinely exported from a developer shell, so a route result would otherwise
// depend on how that shell happens to be configured. Values are deliberately not captured
// in `original`: the API key must not be retained (let alone printed) by the harness.
delete process.env.OPENCODE_UNRESTRICTED
delete process.env.OPENCODE_API_KEY

export const cleanupExercisePaths = Effect.promise(async () => {
  const fs = await import("fs/promises")
  if (!preserveExerciseDatabase) {
    await Promise.all(
      [exerciseDatabasePath, `${exerciseDatabasePath}-wal`, `${exerciseDatabasePath}-shm`].map((file) =>
        fs.rm(file, { force: true }).catch(() => undefined),
      ),
    )
  }
  if (!preserveExerciseGlobalRoot)
    await fs.rm(exerciseGlobalRoot, { recursive: true, force: true }).catch(() => undefined)
})
