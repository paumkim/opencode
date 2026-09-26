import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  accountUsage,
  completeGoal,
  createGoal,
  extendGoal,
  getGoal,
  markGoalUnmet,
  readState,
  recordAssistantProgress,
  recordContinuationResult,
  reserveContinuation,
  setGoalStatus,
  updateGoalObjective,
  statePath,
} from "@/goal/impl"
import goalPlugin, { GOAL_PLUGIN_ID } from "@/plugin/goal/server"
import { internalPluginIds, internalPluginOptions } from "@/plugin/index"
import { GOAL_DEFAULT_MAX_AUTO_TURNS } from "@/goal/schema"
import { GOAL_PROMPT } from "@opencode-ai/core/plugin/command"

let stateDir: string | undefined
const previous = process.env.OPENCODE_GOAL_STATE_PATH

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "opencode-goal-regression-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(stateDir, "goals.json")
})

afterEach(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true })
  stateDir = undefined
  if (previous === undefined) delete process.env.OPENCODE_GOAL_STATE_PATH
  else process.env.OPENCODE_GOAL_STATE_PATH = previous
})

/** The turn default the plugin actually enforces at runtime. */
const RUNTIME_DEFAULT_MAX_AUTO_TURNS = GOAL_DEFAULT_MAX_AUTO_TURNS

describe("C1: extension reactivation must agree with runtime turn enforcement", () => {
  test("null maxAutoTurns past the old 25-turn default is still unlimited and re-extends", async () => {
    const sessionID = "c1-unlimited"
    await createGoal(sessionID, "long runner", { tokenBudget: 1_000, maxAutoTurns: null, sessionTokensAtCreation: 0 })
    await accountUsage(sessionID, 5_000)
    expect((await getGoal(sessionID))?.status).toBe("budgetLimited")

    // Drive 30 auto-continues while repeatedly re-activating and re-exhausting, which is what a
    // long-running unlimited goal does. Before the fix, extendGoal resolved a 25-turn default
    // here while the runtime resolved "unbounded", wedging the goal permanently.
    for (let i = 0; i < 30; i++) {
      const state = await readState()
      if (state.goals[sessionID].status === "budgetLimited" || state.goals[sessionID].status === "usageLimited") {
        await extendGoal(sessionID, { tokenBudget: 1_000_000, maxAutoTurns: null }, RUNTIME_DEFAULT_MAX_AUTO_TURNS)
      }
      expect((await reserveContinuation(sessionID, RUNTIME_DEFAULT_MAX_AUTO_TURNS, 0))?.status).toBe("active")
      await accountUsage(sessionID, 5_000 + (i + 1) * 1_000)
    }

    await accountUsage(sessionID, 100_000_000)
    expect((await getGoal(sessionID))?.status).toBe("budgetLimited")

    const extended = await extendGoal(
      sessionID,
      { tokenBudget: 900_000_000, maxAutoTurns: null },
      RUNTIME_DEFAULT_MAX_AUTO_TURNS,
    )
    expect(extended.status).toBe("active")
    expect(extended.autoTurns).toBe(30)
  })

  test("extension still refuses when the new limit does not admit recorded usage", async () => {
    const sessionID = "c1-refuse"
    await createGoal(sessionID, "budgeted", { tokenBudget: 100, sessionTokensAtCreation: 0 })
    await accountUsage(sessionID, 500)
    expect((await getGoal(sessionID))?.status).toBe("budgetLimited")
    // tokensUsed is 500, so a 500 budget does not admit it and the goal must stay limited.
    const refused = await extendGoal(sessionID, { tokenBudget: 500, maxAutoTurns: null }, RUNTIME_DEFAULT_MAX_AUTO_TURNS)
    expect(refused.status).toBe("budgetLimited")
    expect(refused.lastStatus).toContain("cumulative usage still exceeds")
  })

  test("a genuinely configured turn limit is still enforced and reported by extension", async () => {
    const sessionID = "c1-bounded"
    // defaultMaxAutoTurns=2 mirrors an operator configuring max_auto_turns=2.
    await createGoal(sessionID, "bounded", { maxAutoTurns: null })
    expect((await reserveContinuation(sessionID, 2, 0))?.status).toBe("active")
    expect((await reserveContinuation(sessionID, 2, 0))?.status).toBe("active")
    expect((await reserveContinuation(sessionID, 2, 0))?.status).toBe("usageLimited")
    expect((await getGoal(sessionID))?.stopReason).toContain("max auto-continues")

    // Extending cannot manufacture headroom where the configured cap is genuinely exhausted.
    const refused = await extendGoal(sessionID, { tokenBudget: 5_000 }, 2)
    expect(refused.status).toBe("usageLimited")
    expect(refused.lastStatus).toContain("cumulative usage still exceeds")

    // Raising the cap above recorded usage DOES reactivate.
    const reactivated = await extendGoal(sessionID, { maxAutoTurns: 3 }, 2)
    expect(reactivated.status).toBe("active")
  })
})

describe("C2: partial state must not produce NaN or brick the state file", () => {
  test("a state file missing continuationFailures still trips the failure breaker", async () => {
    const sessionID = "c2-breaker"
    await createGoal(sessionID, "breaker", { maxAutoTurns: 100 })
    const file = statePath()
    const raw = JSON.parse(await Bun.file(file).text())
    delete raw.goals[sessionID].continuationFailures
    await writeFile(file, JSON.stringify(raw, null, 2))

    // Before the fix this was NaN, so `NaN >= maxFailures` was false and the breaker never fired.
    for (let i = 0; i < 3; i++) await recordContinuationResult(sessionID, "failure", 3)
    const goal = await getGoal(sessionID)
    expect(goal?.status).toBe("paused")
    expect(goal?.continuationFailures).toBe(3)
    expect(goal?.stopReason).toBe("auto-continue failures")

    // And the value must survive a round trip rather than degrading to null.
    const onDisk = JSON.parse(await Bun.file(statePath()).text())
    expect(onDisk.goals[sessionID].continuationFailures).toBe(3)
    expect((await getGoal(sessionID))?.status).toBe("paused")
  })

  test("optional arithmetic fields are normalized from a partial state file", async () => {
    const sessionID = "c2-partial"
    await createGoal(sessionID, "partial", { maxAutoTurns: 100 })
    const raw = JSON.parse(await Bun.file(statePath()).text())
    // Only fields the schema marks optional may be absent; deleting a required field is a decode
    // failure and is covered by the H3 quarantine test.
    for (const field of ["continuationFailures", "noProgressTurns", "history", "checkpoints", "budgetWrapupSent"]) {
      delete raw.goals[sessionID][field]
    }
    await writeFile(statePath(), JSON.stringify(raw, null, 2))

    const state = await readState()
    const goal = state.goals[sessionID]
    expect(goal.continuationFailures).toBe(0)
    expect(goal.noProgressTurns).toBe(0)
    expect(goal.budgetWrapupSent).toBe(false)
    expect(goal.history).toEqual([])
    expect(goal.checkpoints).toEqual([])
  })

  test("negative and fractional counters are normalized rather than trusted", async () => {
    const sessionID = "c2-negative"
    await createGoal(sessionID, "negative", { maxAutoTurns: 100 })
    const raw = JSON.parse(await Bun.file(statePath()).text())
    raw.goals[sessionID].continuationFailures = -5
    raw.goals[sessionID].noProgressTurns = 2.7
    await writeFile(statePath(), JSON.stringify(raw, null, 2))

    const goal = (await readState()).goals[sessionID]
    expect(goal.continuationFailures).toBe(0)
    expect(goal.noProgressTurns).toBe(0)
  })
})

describe("H3: a corrupt state file is quarantined instead of disabling goal mode", () => {
  test("undecodable state is moved aside and goal state recovers", async () => {
    await createGoal("h3", "survivor", { maxAutoTurns: 10 })
    await writeFile(statePath(), "{ this is not json")

    // Must not throw: goal tracking degrades to empty rather than failing every session.
    const goal = await getGoal("h3")
    expect(goal).toBeNull()

    // A new goal must be creatable afterwards, i.e. the subsystem is usable again.
    const fresh = await createGoal("h3", "after recovery", { maxAutoTurns: 10 })
    expect(fresh.status).toBe("active")
    expect(fresh.objective).toBe("after recovery")

    const siblings = (await readdir(stateDir!)).filter((name) => name.includes(".corrupt-"))
    expect(siblings.length).toBe(1)
  })

  test("a schema-invalid state file is also recoverable", async () => {
    await writeFile(statePath(), JSON.stringify({ version: 1, goals: { bad: { sessionID: "bad" } } }))
    expect(await getGoal("bad")).toBeNull()
    expect((await createGoal("bad", "recovered")).status).toBe("active")
  })
})

describe("H1: a closed goal is immutable", () => {
  test("a completed goal cannot be re-closed as unmet, and keeps its evidence", async () => {
    const completed = await (async () => {
      await createGoal("h1", "ship it", { maxAutoTurns: 10 })
      return completeGoal("h1", "all checks green")
    })()
    expect(completed.status).toBe("complete")
    expect(completed.completionEvidence).toBe("all checks green")

    await expect(markGoalUnmet("h1", "actually not done")).rejects.toThrow("already closed")

    const after = await getGoal("h1")
    expect(after?.status).toBe("complete")
    expect(after?.completionEvidence).toBe("all checks green")
    expect(after?.blocker).toBeNull()
  })

  test("an unmet goal cannot be re-closed as complete", async () => {
    await createGoal("h1-unmet", "blocked", { maxAutoTurns: 10 })
    await markGoalUnmet("h1-unmet", "waiting on external input")
    await expect(completeGoal("h1-unmet", "it is done after all")).rejects.toThrow("already closed")
    const after = await getGoal("h1-unmet")
    expect(after?.status).toBe("unmet")
    expect(after?.blocker).toBe("waiting on external input")
  })

  test("a closed goal stops accruing token usage", async () => {
    await createGoal("h1-tokens", "immutable accounting", { maxAutoTurns: 10, sessionTokensAtCreation: 0 })
    await accountUsage("h1-tokens", 1_000)
    await completeGoal("h1-tokens", "done")
    const atClose = (await getGoal("h1-tokens"))!.tokensUsed
    await accountUsage("h1-tokens", 50_000)
    expect((await getGoal("h1-tokens"))?.tokensUsed).toBe(atClose)
  })
})

describe("H2/H4: auto-continue failures must not convert a limited goal into a resumable one", () => {
  test("repeated failures on a budgetLimited goal keep it limited and keep its stop reason", async () => {
    const sessionID = "h2"
    await createGoal(sessionID, "budgeted", { tokenBudget: 10, sessionTokensAtCreation: 0 })
    await accountUsage(sessionID, 50)
    expect((await getGoal(sessionID))?.status).toBe("budgetLimited")
    const stopReason = (await getGoal(sessionID))!.stopReason

    for (let i = 0; i < 5; i++) await recordContinuationResult(sessionID, "failure", 3)

    const after = await getGoal(sessionID)
    expect(after?.status).toBe("budgetLimited")
    expect(after?.stopReason).toBe(stopReason)
    // The extend-first invariant must therefore still hold.
    await expect(setGoalStatus(sessionID, "active")).rejects.toThrow("explicitly extend")
    await expect(updateGoalObjective(sessionID, "new", "active")).rejects.toThrow("explicitly extend")
  })

  test("repeated failures on an active goal still auto-pause it", async () => {
    await createGoal("h2-active", "active failures", { maxAutoTurns: 100 })
    for (let i = 0; i < 3; i++) await recordContinuationResult("h2-active", "failure", 3)
    const after = await getGoal("h2-active")
    expect(after?.status).toBe("paused")
    expect(after?.stopReason).toBe("auto-continue failures")
  })
})

describe("M1/M2: resume paths behave identically and refresh progress state", () => {
  test("editing the objective resets the no-progress counter just like resuming does", async () => {
    const sessionID = "m2-edit"
    await createGoal(sessionID, "stalls", { maxAutoTurns: 100 })
    // The first low-progress turn only primes the baseline (it counts as "changed"), so two
    // further consecutive low-progress turns are needed to reach maxNoProgressTurns=2.
    for (const id of ["a", "b", "c"]) {
      await reserveContinuation(sessionID, 0, 0)
      await recordContinuationResult(sessionID, "success", 3)
      await recordAssistantProgress(sessionID, { messageID: id, text: "same", outputTokens: 1, evaluateContinuation: true })
    }
    const stalled = await getGoal(sessionID)
    expect(stalled?.status).toBe("paused")
    expect(stalled?.noProgressTurns).toBe(2)

    // Before the fix, updateGoalObjective left noProgressTurns at 2, so the very next low-progress
    // turn immediately re-paused the goal after a single turn.
    const edited = await updateGoalObjective(sessionID, "focus on the failing parser", "active")
    expect(edited.status).toBe("active")
    expect(edited.noProgressTurns).toBe(0)
    expect(edited.continuationFailures).toBe(0)
  })

  test("a zero-output turn counts as no progress, not as progress", async () => {
    const sessionID = "m3-zero"
    await createGoal(sessionID, "silent", { maxAutoTurns: 100 })
    // Prime the baseline with a real turn, so the next turn is compared against it.
    await reserveContinuation(sessionID, 0, 0)
    await recordContinuationResult(sessionID, "success", 3)
    await recordAssistantProgress(sessionID, { messageID: "z0", text: "same", outputTokens: 500, evaluateContinuation: true })
    expect((await getGoal(sessionID))?.noProgressTurns).toBe(0)

    await reserveContinuation(sessionID, 0, 0)
    await recordContinuationResult(sessionID, "success", 3)
    // No outputTokens at all (provider reports no step tokens) must not be scored as progress.
    await recordAssistantProgress(sessionID, { messageID: "z1", text: "same", evaluateContinuation: true })
    const after = await getGoal(sessionID)
    expect(after?.noProgressTurns).toBe(1)
    expect(after?.status).toBe("active")
  })

  test("a repeated status call is a no-op rather than a fresh history entry", async () => {
    const sessionID = "l10"
    await createGoal(sessionID, "no churn", { maxAutoTurns: 10 })
    const before = (await getGoal(sessionID))!.history.length
    await setGoalStatus(sessionID, "paused")
    const afterPause = (await getGoal(sessionID))!.history.length
    await setGoalStatus(sessionID, "paused")
    expect((await getGoal(sessionID))!.history.length).toBe(afterPause)
    expect(afterPause).toBe(before + 1)
  })

  test("an oscillating checkpoint does not spend the checkpoint budget", async () => {
    const sessionID = "l11"
    await createGoal(sessionID, "oscillating", { maxAutoTurns: 100 })
    for (const [id, text] of [["1", "alpha"], ["2", "beta"], ["3", "alpha"], ["4", "beta"]] as const) {
      await recordAssistantProgress(sessionID, { messageID: id, text, outputTokens: 500 })
    }
    const goal = await getGoal(sessionID)
    expect(goal!.checkpoints.map((c) => c.summary)).toEqual(["alpha", "beta"])
  })
})

describe("H10: the goal plugin is registered and its tool set matches the shipped prompt", () => {
  test("the goal plugin is part of the internal plugin set", () => {
    const ids = internalPluginIds(flags())
    expect(ids).toContain(GOAL_PLUGIN_ID)
  })

  test("config.plugin_options is forwarded to the matching internal plugin", () => {
    // H8: internal plugins used to be invoked with no second argument, making every option
    // (and the turn watchdog built on max_turn_time) unreachable.
    const configured = { [GOAL_PLUGIN_ID]: { max_auto_turns: 7, auto_continue: false } }
    expect(internalPluginOptions(configured, GOAL_PLUGIN_ID)).toEqual({
      max_auto_turns: 7,
      auto_continue: false,
    })
    // Unrelated plugins and an absent config must resolve to undefined, not to a shared object.
    expect(internalPluginOptions(configured, "local.azure")).toBeUndefined()
    expect(internalPluginOptions(undefined, GOAL_PLUGIN_ID)).toBeUndefined()
  })

  test("every tool named by the /goal prompt is actually registered", async () => {
    const registered = await registeredToolNames()
    const named = new Set(
      GOAL_PROMPT.match(/\b(?:create|set|get|extend|clear|update)_goal[a-z_]*\b/g) ?? [],
    )
    expect(named.size).toBeGreaterThan(0)
    for (const tool of named) {
      expect(registered).toContain(tool)
    }
  })

  test("the /goal command ships the single shared prompt", () => {
    // The prompt must come from the one shared source, not a second drifting copy.
    const source = GOAL_PROMPT
    expect(source).toContain("<goal_command_arguments>")
    expect(source).toContain("$ARGUMENTS")
    expect(source).toContain('"resume"')
  })
})

async function registeredToolNames() {
  const hooks = await goalPlugin.server({ client: fakeClient() } as never, {})
  return Object.keys(hooks.tool ?? {})
}

function fakeClient() {
  return {
    session: {
      get: () => ({ data: { id: "s" } }),
      messages: () => ({ data: [] }),
      children: () => ({ data: [] }),
      status: () => ({ data: {} }),
      promptAsync: () => ({ data: undefined }),
      command: () => ({ data: {} }),
    },
    app: { log: () => ({ data: {} }) },
  }
}

function flags() {
  return {
    experimentalWebSockets: false,
    disableDefaultPlugins: false,
    pure: false,
  } as never
}
