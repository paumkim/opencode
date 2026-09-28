import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { Global } from "@opencode-ai/core/global"
import { InstanceState } from "../../src/effect/instance-state"
import { Git } from "../../src/git"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances, provideInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Worktree.node, FSUtil.node, Git.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ]),
)
const wintest = process.platform !== "win32" ? it.instance : it.instance.skip

function normalize(input: string) {
  return input.replace(/\\/g, "/").toLowerCase()
}

const waitReady = Effect.fn("WorktreeTest.waitReady")(function* () {
  const ready = yield* Deferred.make<{ name: string; branch?: string }>()
  const on = (evt: GlobalEvent) => {
    if (evt.payload.type !== Worktree.Event.Ready.type) return
    Deferred.doneUnsafe(ready, Effect.succeed(evt.payload.properties))
  }

  GlobalBus.on("event", on)
  yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

  return yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
    }),
  )
})

const removeCreatedWorktree = (directory: string) =>
  Effect.gen(function* () {
    const svc = yield* Worktree.Service
    const ok = yield* svc.remove({ directory })
    if (!ok) return yield* Effect.fail(new Error(`failed to remove worktree ${directory}`))
  })

const withCreatedWorktree = <A, E, R>(
  input: Parameters<Worktree.Interface["create"]>[0],
  use: (created: { info: Worktree.Info; ready: { name: string; branch?: string } }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const svc = yield* Worktree.Service
      const ready = yield* waitReady().pipe(Effect.forkScoped)
      const info = yield* svc.create(input)
      const props = yield* Fiber.join(ready)
      return { info, ready: props }
    }),
    use,
    ({ info }) => removeCreatedWorktree(info.directory),
  )

const git = Effect.fn("WorktreeTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
  return result.text()
})

const gitResult = Effect.fn("WorktreeTest.gitResult")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  return yield* service.run(args, { cwd })
})

describe("Worktree", () => {
  afterEach(() => disposeAllInstances())

  describe("makeWorktreeInfo", () => {
    it.instance(
      "returns info with name, branch, and directory",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo()

          expect(info.name).toBeDefined()
          expect(typeof info.name).toBe("string")
          expect(info.branch).toBe(`opencode/${info.name}`)
          expect(info.directory).toContain(info.name)
        }),
      { git: true },
    )

    it.instance(
      "uses provided name as base",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "my-feature" })

          expect(info.name).toBe("my-feature")
          expect(info.branch).toBe("opencode/my-feature")
        }),
      { git: true },
    )

    it.instance(
      "slugifies the provided name",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "My Feature Branch!" })

          expect(info.name).toBe("my-feature-branch")
        }),
      { git: true },
    )

    it.instance(
      "omits branch for detached info",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          yield* git(test.directory, ["branch", "opencode/my-feature"])

          const info = yield* svc.makeWorktreeInfo({ name: "my-feature", detached: true })

          expect(info.name).toBe("my-feature")
          expect(info.branch).toBeUndefined()
        }),
      { git: true },
    )

    it.instance("fails with NotGitError for non-git directories", () =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        const exit = yield* Effect.exit(svc.makeWorktreeInfo())

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(Worktree.NotGitError)
          if (error instanceof Worktree.NotGitError) expect(error._tag).toBe("WorktreeNotGitError")
        }
      }),
    )

    wintest(
      "creates detached git worktree when info has no branch",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "detached-test", detached: true })
          const ready = yield* waitReady().pipe(Effect.forkScoped)
          yield* svc.createFromInfo(info)

          const list = yield* git(test.directory, ["worktree", "list", "--porcelain"])
          const normalizedList = normalize(list)
          const normalizedDir = normalize(info.directory)
          expect(normalizedList).toContain(normalizedDir)

          const branch = yield* gitResult(info.directory, ["symbolic-ref", "-q", "--short", "HEAD"])
          expect(branch.exitCode).not.toBe(0)

          const props = yield* Fiber.join(ready)
          expect(props.name).toBe(info.name)
          expect(props.branch).toBeUndefined()

          yield* svc.remove({ directory: info.directory })
        }),
      { git: true },
    )
  })

  describe("create + remove lifecycle", () => {
    it.instance(
      "create returns worktree info and remove cleans up",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            expect(info.name).toBeDefined()
            expect(info.branch ?? "").toStartWith("opencode/")
            expect(info.directory).toBeDefined()
          }),
        ),
      { git: true },
    )

    it.instance(
      "create returns after setup and fires Event.Ready after bootstrap",
      () =>
        withCreatedWorktree(undefined, ({ info, ready }) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service

            expect(info.name).toBeDefined()
            expect(info.branch ?? "").toStartWith("opencode/")

            expect(ready.name).toBe(info.name)
            expect(ready.branch).toBe(info.branch)

            const list = yield* svc.list()
            expect(list).toContainEqual(expect.objectContaining({ name: info.name, branch: info.branch }))
          }),
        ),
      { git: true },
    )

    it.instance(
      "lists the active linked worktree but not the project checkout",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            const test = yield* TestInstance
            const svc = yield* Worktree.Service
            const list = yield* svc.list().pipe(provideInstance(info.directory))

            expect(list.map((item) => item.name)).toContain(info.name)
            expect(list.map((item) => item.name)).not.toContain(path.basename(test.directory).toLowerCase())
          }),
        ),
      { git: true },
    )

    it.instance(
      "create with custom name",
      () =>
        withCreatedWorktree({ name: "test-workspace" }, ({ info }) =>
          Effect.gen(function* () {
            expect(info.name).toBe("test-workspace")
            expect(info.branch).toBe("opencode/test-workspace")
          }),
        ),
      { git: true },
    )
  })

  describe("createFromInfo", () => {
    wintest(
      "creates git worktree and boots asynchronously",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "from-info-test" })
          const ready = yield* waitReady().pipe(Effect.forkScoped)
          yield* svc.createFromInfo(info)

          const list = yield* git(test.directory, ["worktree", "list", "--porcelain"])
          const normalizedList = list.replace(/\\/g, "/")
          const normalizedDir = info.directory.replace(/\\/g, "/")
          expect(normalizedList).toContain(normalizedDir)

          yield* Fiber.join(ready)
          yield* removeCreatedWorktree(info.directory)
        }),
      { git: true },
    )
  })

  describe("list", () => {
    it.instance(
      "uses parent folder name when worktree basename matches the primary worktree",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const fs = yield* FSUtil.Service
          const svc = yield* Worktree.Service
          const parent = path.join(path.dirname(test.directory), `${path.basename(test.directory)}-parent`)
          const target = path.join(parent, path.basename(test.directory))
          const branch = `same-basename-list-${Date.now()}`

          yield* fs.ensureDir(parent)
          yield* git(test.directory, ["worktree", "add", "-b", branch, target])

          const list = yield* svc.list()
          const directory = yield* fs.realPath(target).pipe(Effect.catch(() => Effect.succeed(target)))

          expect(list.map((item) => ({ ...item, directory: normalize(item.directory) }))).toContainEqual({
            name: path.basename(parent),
            branch,
            directory: normalize(directory),
          })

          yield* svc.remove({ directory: target })
        }),
      { git: true },
    )
  })

  // `Worktree.reset` backs `POST /experimental/worktree/reset` and had no test at all. It is the
  // most destructive thing in this module: it fetches, then `reset --hard`, `clean -ffdx`, and
  // three recursive submodule resets/cleans, all inside a caller-supplied directory. The two guards
  // it does have -- refusing the primary workspace, and requiring git to list the path as a
  // worktree -- are what keep that from being aimed at the project checkout or an arbitrary
  // directory, so they are asserted here rather than assumed.
  describe("reset", () => {
    it.instance(
      "refuses to reset the primary workspace",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const exit = yield* Effect.exit(svc.reset({ directory: test.directory }))

          expect(Exit.isFailure(exit)).toBe(true)
          if (!Exit.isFailure(exit)) return
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(Worktree.ResetFailedError)
          if (error instanceof Worktree.ResetFailedError) expect(error.message).toContain("primary workspace")
        }),
      { git: true },
    )

    // The primary guard is a string comparison on the canonical path, so a path that merely
    // contains the primary's path is a different directory and must not be refused for the wrong
    // reason -- it should be refused because git does not know it.
    it.instance(
      "reports a path git does not know as not found, not as the primary workspace",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const unknown = path.join(test.directory, "not-a-worktree")
          const exit = yield* Effect.exit(svc.reset({ directory: unknown }))

          expect(Exit.isFailure(exit)).toBe(true)
          if (!Exit.isFailure(exit)) return
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(Worktree.ResetFailedError)
          if (error instanceof Worktree.ResetFailedError) expect(error.message).toBe("Worktree not found")
        }),
      { git: true },
    )

    // The happy path, and the guarantee the guards exist to protect.
    //
    // Two facts about this code shaped the fixture, and both were wrong in my first attempt:
    //
    //   - `reset` rewinds to the DEFAULT branch (`reset --hard <default-branch>`), not to the tip of
    //     the worktree's own branch, so a commit made on the worktree branch is discarded by design.
    //   - the worktree sits on its own branch, so a file committed only to the default branch is
    //     UNTRACKED there, not modified. `clean -ffdx` removes it; `reset --hard` is what rewinds a
    //     file that is genuinely tracked and modified.
    //
    // So the tracked-and-modified case needs the file committed on the WORKTREE's own branch, and the
    // untracked case is a second file. Asserting the wrong one of those two makes the test pass while
    // pinning the wrong git command -- dropping `reset --hard` left it green until this was split.
    it.instance(
      "rewinds a tracked file to the base branch and removes untracked files, leaving the primary alone",
      () =>
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            const test = yield* TestInstance
            yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "base.txt"), "base content\n"))
            yield* git(test.directory, ["add", "base.txt"])
            yield* git(test.directory, ["commit", "-m", "add base"])
            const ready = yield* waitReady().pipe(Effect.forkScoped)
            const svc = yield* Worktree.Service
            const info = yield* svc.create()
            yield* Fiber.join(ready)
            return info
          }),
          (info) =>
            Effect.gen(function* () {
              const test = yield* TestInstance
              const svc = yield* Worktree.Service

              // Inherited from the default branch at branch time, so it is tracked AND present at the
              // base ref. Rewinding it is `reset --hard`'s job.
              const baseTracked = path.join(info.directory, "base.txt")
              yield* Effect.promise(() => fs.writeFile(baseTracked, "local edit\n"))
              // Committed on the WORKTREE's branch, so it is absent from the base tree.
              const tracked = path.join(info.directory, "wt-tracked.txt")
              yield* Effect.promise(() => fs.writeFile(tracked, "worktree commit\n"))
              yield* git(info.directory, ["add", "wt-tracked.txt"])
              yield* git(info.directory, ["commit", "-m", "worktree commit"])
              yield* Effect.promise(() => fs.writeFile(tracked, "local edit\n"))

              // Never committed anywhere, so `clean -ffdx` is what removes it.
              const untracked = path.join(info.directory, "untracked.txt")
              yield* Effect.promise(() => fs.writeFile(untracked, "junk\n"))

              // Committed on the worktree's branch only, so it is absent from the base tree.
              const branchOnly = path.join(info.directory, "wt-only.txt")
              yield* Effect.promise(() => fs.writeFile(branchOnly, "branch only\n"))
              yield* git(info.directory, ["add", "wt-only.txt"])
              yield* git(info.directory, ["commit", "-m", "branch only"])

              const primaryFile = path.join(test.directory, "primary.txt")
              yield* Effect.promise(() => fs.writeFile(primaryFile, "must survive\n"))

              // Precondition: `baseTracked` really is tracked AND locally modified before the reset.
              // Without this, "it reads back as the base content" could be true simply because the
              // edit never landed, which is what made an earlier draft of this test vacuous.
              expect(yield* Effect.promise(() => fs.readFile(baseTracked, "utf8"))).toBe("local edit\n")
              const statusBefore = yield* gitResult(info.directory, ["status", "--porcelain"])
              expect(statusBefore.text()).toContain("base.txt")

              const ok = yield* svc.reset({ directory: info.directory })
              expect(ok).toBe(true)

              // `baseTracked` was committed to the default branch BEFORE the worktree branched off,
              // so it is present at the base ref and `reset --hard <base>` restores its committed
              // content. `clean -ffdx` leaves tracked files alone, so only that command can produce
              // this -- which is what pins it.
              expect(yield* Effect.promise(() => fs.readFile(baseTracked, "utf8"))).toBe("base content\n")
              // `wt-tracked.txt` and `branchOnly` were committed only on the worktree branch, so they
              // are not in the base tree and the reset removes both outright.
              for (const gone of [tracked, branchOnly]) {
                expect(
                  yield* Effect.promise(() =>
                    fs
                      .stat(gone)
                      .then(() => true)
                      .catch(() => false),
                  ),
                ).toBe(false)
              }
              expect(
                yield* Effect.promise(() =>
                  fs
                    .stat(untracked)
                    .then(() => true)
                    .catch(() => false),
                ),
              ).toBe(false)
              // The primary checkout is not one of its own worktrees and must be untouched.
              expect(yield* Effect.promise(() => fs.readFile(primaryFile, "utf8"))).toBe("must survive\n")
            }),
          (info) =>
            Effect.gen(function* () {
              const svc = yield* Worktree.Service
              yield* svc.remove({ directory: info.directory })
            }),
        ),
      { git: true },
    )
  })

  describe("remove edge cases", () => {
    // `remove` takes a `directory` off the wire (`DELETE /experimental/worktree`) and, when git does
    // not know that path, used to delete it anyway. `create` only ever places a worktree under
    // `<data>/worktree/<projectID>`, so a path outside that root is not ours to remove -- and the
    // delete was recursive. Verified before the fix: a plain directory holding one file came back
    // gone while `remove` returned `true`.
    it.instance(
      "refuses to delete a directory outside the worktree root",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const victim = path.join(test.directory, "not-a-worktree")
          const data = path.join(victim, "user-data.txt")
          yield* Effect.promise(() => fs.mkdir(victim, { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(data, "precious"))

          // The path is inside the project and is a real directory, but it is not a worktree, so
          // `locateWorktree` finds nothing -- which is exactly the case that used to delete it.
          const ok = yield* svc.remove({ directory: victim })

          expect(ok).toBe(true)
          expect(
            yield* Effect.promise(() =>
              fs
                .stat(data)
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(true)
        }),
      { git: true },
    )

    // The branch guarded above exists for a real case: a directory this service created, inside the
    // root, that git no longer lists (an interrupted bootstrap, a manually pruned registration). That
    // must still be cleaned, so the containment check is on the root, not a blanket refusal.
    it.instance(
      "still cleans a stale directory inside the worktree root that git does not list",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const ctx = yield* InstanceState.context
          const stale = path.join(Global.Path.data, "worktree", ctx.project.id, `stale-${Date.now().toString(36)}`)
          yield* Effect.promise(() => fs.mkdir(stale, { recursive: true }))
          const data = path.join(stale, "x.txt")
          yield* Effect.promise(() => fs.writeFile(data, "x"))

          const ok = yield* svc.remove({ directory: stale })

          expect(ok).toBe(true)
          expect(
            yield* Effect.promise(() =>
              fs
                .stat(stale)
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false)
        }),
      { git: true },
    )

    // A sibling whose name merely shares the worktree root's prefix as a string must be rejected
    // too: `<root>` is `/…/worktree/<id>` and this is `/…/worktree-evil/…`, so a plain string
    // `startsWith` would accept it. `FSUtil.contains` compares path components.
    it.instance(
      "refuses a sibling directory whose name shares the worktree root's prefix",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const outside = path.join(Global.Path.data, "worktree-evil", `probe-${Date.now().toString(36)}`)
          yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
          const data = path.join(outside, "keep.txt")
          yield* Effect.promise(() => fs.writeFile(data, "precious"))

          yield* svc.remove({ directory: outside })

          expect(
            yield* Effect.promise(() =>
              fs
                .stat(data)
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(true)
          yield* Effect.promise(() => fs.rm(outside, { recursive: true, force: true }))
        }),
      { git: true },
    )

    it.instance(
      "remove non-existent directory succeeds silently",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const ok = yield* svc.remove({ directory: path.join(test.directory, "does-not-exist") })
          expect(ok).toBe(true)
        }),
      { git: true },
    )

    it.instance("fails with NotGitError for non-git directories", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const exit = yield* Effect.exit(svc.remove({ directory: path.join(test.directory, "fake") }))

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(Worktree.NotGitError)
          if (error instanceof Worktree.NotGitError) expect(error._tag).toBe("WorktreeNotGitError")
        }
      }),
    )
  })
})
