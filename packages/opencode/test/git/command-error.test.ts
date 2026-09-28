import { $ } from "bun"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Git } from "../../src/git"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))

const scopedTmpdir = (options?: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

// A corrupt index is the most ordinary way a real worktree breaks: git exits
// 128 and explains itself on stderr. Before this fix all three reads below went
// through `text()`, which kept only stdout and threw stderr away, so the empty
// stdout parsed as "no files changed" — indistinguishable from a clean tree.
const withCorruptIndex = (path: string) =>
  Effect.promise(() => $`printf garbage-not-an-index > .git/index`.cwd(path).quiet())

describe("Git.CommandError", () => {
  it.live("status() fails with git's own diagnostic instead of reporting a clean tree", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const git = yield* Git.Service
      yield* withCorruptIndex(tmp.path)

      const error = yield* Effect.flip(git.status(tmp.path))

      expect(error).toBeInstanceOf(Git.CommandError)
      if (!(error instanceof Git.CommandError)) return
      // The message is git's, not a generic "git failed": without it the user
      // cannot tell a corrupt index from a missing binary.
      expect(error.message).toContain("index file smaller than expected")
      // The exit code and argv are carried so the failure is reproducible.
      expect(error.exitCode).toBe(128)
      expect(error.args[0]).toBe("status")
    }),
  )

  it.live("diff() fails rather than reporting no changes", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const git = yield* Git.Service
      yield* withCorruptIndex(tmp.path)

      const error = yield* Effect.flip(git.diff(tmp.path, "HEAD"))

      expect(error).toBeInstanceOf(Git.CommandError)
      if (!(error instanceof Git.CommandError)) return
      expect(error.message).toContain("index file smaller than expected")
      expect(error.args).toContain("--name-status")
    }),
  )

  it.live("stats() fails rather than reporting no line counts", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const git = yield* Git.Service
      yield* withCorruptIndex(tmp.path)

      const error = yield* Effect.flip(git.stats(tmp.path, "HEAD"))

      expect(error).toBeInstanceOf(Git.CommandError)
      if (!(error instanceof Git.CommandError)) return
      expect(error.message).toContain("index file smaller than expected")
      expect(error.args).toContain("--numstat")
    }),
  )

  // Guard against over-reaching: the ref probes below answer "is there a branch",
  // where a silent undefined is a real answer (an unborn HEAD, a repo with no
  // remotes). They are not "what changed" reads, so they must keep degrading.
  it.live("branch() and defaultBranch() still degrade to undefined, not an error", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const git = yield* Git.Service
      yield* withCorruptIndex(tmp.path)

      const branch = yield* git.branch(tmp.path)
      const root = yield* git.defaultBranch(tmp.path)

      expect(typeof branch).toBe("string")
      expect(root?.name).toBeDefined()
    }),
  )

  // A healthy worktree must still report its changes, or the fix is just a new
  // way of always failing.
  it.live("status() still reports real changes on a healthy worktree", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const git = yield* Git.Service
      yield* Effect.promise(() => $`echo changed > a.txt`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`echo new > untracked.txt`.cwd(tmp.path).quiet())

      const list = yield* git.status(tmp.path)

      expect(list.map((item) => item.file).toSorted()).toEqual(["a.txt", "untracked.txt"])
    }),
  )
})
