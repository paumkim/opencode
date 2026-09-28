import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd, fail } from "../effect-cmd"
import { Git } from "@/git"
import { InstanceRef } from "@/effect/instance-ref"
import { Process } from "@/util/process"

export const PrCommand = effectCmd({
  command: "pr <number>",
  describe: "fetch and checkout a GitHub PR branch, then run opencode",
  builder: (yargs) =>
    yargs.positional("number", {
      type: "number",
      describe: "PR number to checkout",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.pr")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* fail("Could not load instance context")
    if (ctx.project.vcs !== "git") {
      return yield* fail("Could not find git repository. Please run this command from a git repository.")
    }

    const git = yield* Git.Service
    const worktree = ctx.worktree

    const prNumber = args.number
    const localBranchName = `pr/${prNumber}`
    UI.println(`Fetching and checking out PR #${prNumber}...`)

    const checkout = yield* Effect.promise(() =>
      Process.run(["gh", "pr", "checkout", `${prNumber}`, "--branch", localBranchName, "--force"], { nothrow: true }),
    )
    if (checkout.code !== 0) {
      return yield* fail(`Failed to checkout PR #${prNumber}. Make sure you have gh CLI installed and authenticated.`)
    }

    const prInfoResult = yield* Effect.promise(() =>
      Process.text(
        [
          "gh",
          "pr",
          "view",
          `${prNumber}`,
          "--json",
          "headRepository,headRepositoryOwner,isCrossRepository,headRefName,body",
        ],
        { nothrow: true },
      ),
    )

    let sessionId: string | undefined

    if (prInfoResult.code === 0 && prInfoResult.text.trim()) {
      const prInfo = JSON.parse(prInfoResult.text)

      if (prInfo?.isCrossRepository && prInfo.headRepository && prInfo.headRepositoryOwner) {
        const forkOwner = prInfo.headRepositoryOwner.login
        const forkName = prInfo.headRepository.name
        const remoteName = forkOwner

        // Everything below is best-effort enrichment of a checkout that has
        // already succeeded, so a failure here should not abort the command.
        // It should not be invisible either: `git.run` does not check exit
        // codes, so without these checks a failed `remote add` still printed
        // "Added fork remote", and a failed `--set-upstream-to` left the branch
        // tracking nothing while the command went on to report success.
        const remotes = yield* git.run(["remote"], { cwd: worktree })
        if (remotes.exitCode !== 0) {
          UI.println(
            `Could not list git remotes, skipping fork setup: ${remotes.stderr.toString("utf8").trim() || "git remote failed"}`,
          )
        } else if (!remotes.text().trim().split("\n").includes(remoteName)) {
          const add = yield* git.run(["remote", "add", remoteName, `https://github.com/${forkOwner}/${forkName}.git`], {
            cwd: worktree,
          })
          if (add.exitCode === 0) {
            UI.println(`Added fork remote: ${remoteName}`)
          } else {
            UI.println(
              `Failed to add fork remote ${remoteName}: ${add.stderr.toString("utf8").trim() || "git remote add failed"}`,
            )
          }
        }

        const upstream = yield* git.run(
          ["branch", `--set-upstream-to=${remoteName}/${prInfo.headRefName}`, localBranchName],
          { cwd: worktree },
        )
        if (upstream.exitCode !== 0) {
          UI.println(
            `Failed to track ${remoteName}/${prInfo.headRefName} for ${localBranchName}: ${
              upstream.stderr.toString("utf8").trim() || "git branch --set-upstream-to failed"
            }`,
          )
        }
      }

      if (prInfo?.body) {
        const sessionMatch = prInfo.body.match(/https:\/\/opncd\.ai\/s\/([a-zA-Z0-9_-]+)/)
        if (sessionMatch) {
          const sessionUrl = sessionMatch[0]
          UI.println(`Found opencode session: ${sessionUrl}`)
          UI.println(`Importing session...`)

          const importResult = yield* Effect.promise(() =>
            Process.text(["opencode", "import", sessionUrl], { nothrow: true }),
          )
          if (importResult.code === 0) {
            const sessionIdMatch = importResult.text.trim().match(/Imported session: ([a-zA-Z0-9_-]+)/)
            if (sessionIdMatch) {
              sessionId = sessionIdMatch[1]
              UI.println(`Session imported: ${sessionId}`)
            }
          }
        }
      }
    }

    UI.println(`Successfully checked out PR #${prNumber} as branch '${localBranchName}'`)
    UI.println()
    UI.println("Starting opencode...")
    UI.println()

    const opencodeArgs = sessionId ? ["-s", sessionId] : []
    const code = yield* Effect.promise(
      () =>
        Process.spawn(["opencode", ...opencodeArgs], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          cwd: process.cwd(),
        }).exited,
    )
    // Match legacy throw semantics — propagate as a defect so the top-level
    // index.ts catch handles it identically (exit 1, "Unexpected error" banner).
    if (code !== 0) return yield* Effect.die(new Error(`opencode exited with code ${code}`))
  }),
})
