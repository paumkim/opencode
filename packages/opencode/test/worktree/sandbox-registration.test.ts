import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { registerWorktreeSandbox, sandboxRegistrationFailed } from "@/worktree"
import type { ProjectV2 } from "@opencode-ai/core/project"

const projectID = "prj_1" as ProjectV2.ID

describe("sandbox registration failure", () => {
  test("names the directory the worktree was left at", () => {
    // The directory EXISTS when registration fails - git created it in the step above - so the
    // message has to lead with it. A bare "registration failed" reads as "nothing happened" and
    // leaves the caller unaware of a real directory sitting on disk.
    const error = sandboxRegistrationFailed("/data/worktree/prj_1/feature-a", new Error("db locked"))
    expect(error._tag).toBe("WorktreeCreateFailedError")
    expect(error.message).toContain("/data/worktree/prj_1/feature-a")
    // Both halves: where it is, and why it is not registered.
    expect(error.message).toContain("could not be registered with the project")
    expect(error.message).toContain("db locked")
  })

  test("names the reason for a structured failure rather than stringifying it to an object", () => {
    // `addSandbox` writes through a database driver, whose failures are not necessarily Error
    // instances. A bare String(error) would render "[object Object]" and the caller would learn
    // that registration failed and nothing about why.
    const error = sandboxRegistrationFailed("/tmp/wt", { message: "SQLITE_BUSY: database is locked" })
    expect(error.message).toContain("SQLITE_BUSY: database is locked")
    expect(error.message).not.toContain("[object Object]")
  })
})

describe("registerWorktreeSandbox", () => {
  test("a registration failure reaches the caller instead of resolving", async () => {
    // The regression, driven through the production function. Reverted to
    // `Effect.catch(() => Effect.void)`, this resolves: `boot` then runs, the worktree emits `Ready`
    // and runs its start scripts, and the caller is told the create succeeded - for a directory
    // absent from `project.sandboxes`, the only worktree list a client has.
    const escaped: string[] = []
    await Effect.runPromise(
      registerWorktreeSandbox(projectID, "/data/worktree/prj_1/feature-a", () =>
        Effect.fail(new Error("db locked")),
      ).pipe(Effect.catch((error) => Effect.sync(() => escaped.push(error.message)))),
    )

    expect(escaped).toHaveLength(1)
    expect(escaped[0]).toContain("could not be registered with the project")
    expect(escaped[0]).toContain("/data/worktree/prj_1/feature-a")
    expect(escaped[0]).toContain("db locked")
  })

  test("a successful registration resolves and reports nothing", async () => {
    // The direction that must not regress: an ordinary create still succeeds. A fix that reported
    // unconditionally would "fix" the defect by failing every worktree creation.
    const escaped: string[] = []
    await Effect.runPromise(
      registerWorktreeSandbox(projectID, "/data/worktree/prj_1/feature-a", () => Effect.void).pipe(
        Effect.catch((error) => Effect.sync(() => escaped.push(error.message))),
      ),
    )
    expect(escaped).toEqual([])
  })

  test("passes the project and directory through to the registration call", async () => {
    // Guards the wrapper against quietly calling the wrong thing. Cheap, and the kind of mistake a
    // refactor around a swallowed error makes easily.
    const seen: [string, string][] = []
    await Effect.runPromise(
      registerWorktreeSandbox("prj_9" as ProjectV2.ID, "/data/worktree/prj_9/wt", (projectID, directory) =>
        Effect.sync(() => {
          seen.push([projectID, directory])
        }),
      ),
    )
    expect(seen).toEqual([["prj_9", "/data/worktree/prj_9/wt"]])
  })
})
