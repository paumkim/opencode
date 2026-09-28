import { $ } from "bun"
import { describe, expect } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Worktree.node, [[InstanceStore.bootstrapNode, InstanceBootstrap.node]]))
const wintest = process.platform === "win32" ? it.instance : it.instance.skip

describe("Worktree.remove", () => {
  it.instance(
    "continues when git remove exits non-zero after detaching",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        const name = `remove-regression-${Date.now().toString(36)}`
        const branch = `opencode/${name}`
        const dir = path.join(root, "..", name)

        yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())

        const real = (yield* Effect.promise(() => $`which git`.quiet().text())).trim()
        expect(real).toBeTruthy()

        const bin = path.join(root, "bin")
        const shim = path.join(bin, "git")
        yield* Effect.promise(() => fs.mkdir(bin, { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            shim,
            [
              "#!/bin/bash",
              `REAL_GIT=${JSON.stringify(real)}`,
              'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
              '  "$REAL_GIT" "$@" >/dev/null 2>&1',
              '  echo "fatal: failed to remove worktree: Directory not empty" >&2',
              "  exit 1",
              "fi",
              'exec "$REAL_GIT" "$@"',
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() => fs.chmod(shim, 0o755))

        const prev = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const prev = process.env.PATH ?? ""
            process.env.PATH = `${bin}${path.delimiter}${prev}`
            return prev
          }),
          (prev) =>
            Effect.sync(() => {
              process.env.PATH = prev
            }),
        )
        void prev

        const ok = yield* svc.remove({ directory: dir })

        expect(ok).toBe(true)
        expect(
          yield* Effect.promise(() =>
            fs
              .stat(dir)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(false)

        const list = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(root).quiet().text())
        expect(list).not.toContain(`worktree ${dir}`)

        const ref = yield* Effect.promise(() =>
          $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
        )
        expect(ref.exitCode).not.toBe(0)
      }),
    { git: true },
  )

  // A worktree path whose own name ends in a space is printed by git verbatim, and the porcelain
  // parser used to `.trim()` the value after the `worktree ` prefix. That turned the path into a
  // different directory, so `remove` could not locate the entry and took the "not a worktree of
  // ours" branch: it cleaned the directory and returned `true`. The caller was told the worktree
  // was removed while git still had it registered, and its branch was never deleted.
  it.instance(
    "removes a worktree whose path ends in a space",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        const name = `remove-trailing-space-${Date.now().toString(36)}`
        const branch = `opencode/${name}`
        const dir = path.join(root, "..", name, "wt   ")

        yield* Effect.promise(() => fs.mkdir(path.dirname(dir), { recursive: true }))
        yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())

        // git reports the path exactly as given, trailing space and all.
        const before = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(root).quiet().text())
        expect(before.split("\n")).toContain(`worktree ${dir}`)

        const ok = yield* svc.remove({ directory: dir })

        expect(ok).toBe(true)
        expect(
          yield* Effect.promise(() =>
            fs
              .stat(dir)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(false)

        // The branch must be gone too: reaching the remove path at all is what deletes it, and the
        // silently-skipped path left both the registration and the branch behind.
        const ref = yield* Effect.promise(() =>
          $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
        )
        expect(ref.exitCode).not.toBe(0)
      }),
    { git: true },
  )

  // The other half of `remove`'s failure handling, which the test above does not reach. That shim
  // lets the real `worktree remove` run to completion and only then reports failure, so by the time
  // the code re-lists, the worktree is gone and `locateWorktree` finds nothing -- the "proceed"
  // branch. Here the remove itself does nothing, so git still lists the worktree and `remove` must
  // report the failure instead of going on to delete the directory and the branch.
  //
  // Getting this wrong in the permissive direction is what the branch guards: without the re-check,
  // a remove that failed with the worktree still registered would delete the branch and report
  // success, leaving git and the branch list disagreeing with the filesystem.
  it.instance(
    "fails without touching the worktree when git remove fails and the worktree is still listed",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        const name = `remove-still-listed-${Date.now().toString(36)}`
        const branch = `opencode/${name}`
        const dir = path.join(root, "..", name)

        yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())

        const real = (yield* Effect.promise(() => $`which git`.quiet().text())).trim()
        const bin = path.join(root, "bin")
        const shim = path.join(bin, "git")
        yield* Effect.promise(() => fs.mkdir(bin, { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            shim,
            [
              "#!/bin/bash",
              `REAL_GIT=${JSON.stringify(real)}`,
              'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
              // Deliberately does NOT run the real remove: the worktree stays registered.
              '  echo "fatal: failed to remove worktree" >&2',
              "  exit 1",
              "fi",
              'exec "$REAL_GIT" "$@"',
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() => fs.chmod(shim, 0o755))

        const prev = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const prev = process.env.PATH ?? ""
            process.env.PATH = `${bin}${path.delimiter}${prev}`
            return prev
          }),
          (prev) =>
            Effect.sync(() => {
              process.env.PATH = prev
            }),
        )
        void prev

        const exit = yield* Effect.exit(svc.remove({ directory: dir }))

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(Worktree.RemoveFailedError)
        }
        // The worktree must survive, still registered, with its branch intact: a failed remove is not
        // permission to clean up.
        expect(
          yield* Effect.promise(() =>
            fs
              .stat(dir)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(true)
        const list = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(root).quiet().text())
        expect(list).toContain(`worktree ${dir}`)
        const ref = yield* Effect.promise(() =>
          $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
        )
        expect(ref.exitCode).toBe(0)

        // Undo the shim so the worktree can be removed for real and the temp dir cleaned up.
        process.env.PATH = prev
        yield* Effect.promise(() => $`git worktree remove --force ${dir}`.cwd(root).quiet().nothrow())
        yield* Effect.promise(() => $`git branch -D ${branch}`.cwd(root).quiet().nothrow())
      }),
    { git: true },
  )

  wintest(
    "stops fsmonitor before removing a worktree",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service
        const name = `remove-fsmonitor-${Date.now().toString(36)}`
        const branch = `opencode/${name}`
        const dir = path.join(root, "..", name)

        yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
        yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())
        yield* Effect.promise(() => $`git config core.fsmonitor true`.cwd(dir).quiet())
        yield* Effect.promise(() => $`git fsmonitor--daemon stop`.cwd(dir).quiet().nothrow())
        yield* Effect.promise(() => Bun.write(path.join(dir, "tracked.txt"), "next\n"))
        yield* Effect.promise(() => $`git diff`.cwd(dir).quiet())

        const before = yield* Effect.promise(() => $`git fsmonitor--daemon status`.cwd(dir).quiet().nothrow())
        expect(before.exitCode).toBe(0)

        const ok = yield* svc.remove({ directory: dir })

        expect(ok).toBe(true)
        expect(
          yield* Effect.promise(() =>
            fs
              .stat(dir)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(false)

        const ref = yield* Effect.promise(() =>
          $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
        )
        expect(ref.exitCode).not.toBe(0)
      }),
    { git: true },
  )
})
