import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  accountUsage,
  completeGoal,
  readState,
  createGoal,
  extendGoal,
  getGoal,
  markGoalUnmet,
  recordAssistantProgress,
  reserveContinuation,
  recordContinuationResult,
  setGoalStatus,
  updateGoalObjective,
} from "@/goal/impl"
import { resolveCreateGoalLimits } from "@/goal/shared"

let stateDir: string | undefined
const previous = process.env.OPENCODE_GOAL_STATE_PATH

afterEach(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true })
  stateDir = undefined
  if (previous === undefined) delete process.env.OPENCODE_GOAL_STATE_PATH
  else process.env.OPENCODE_GOAL_STATE_PATH = previous
})

async function isolated() {
  stateDir = await mkdtemp(join(tmpdir(), "opencode-goal-test-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(stateDir, "goals.json")
}

describe("goal budget lifecycle", () => {
  test("charges only session tokens accumulated after goal creation", async () => {
    await isolated()
    const sessionID = "existing-context"
    await createGoal(sessionID, "start at zero", { tokenBudget: 100, sessionTokensAtCreation: 1_000 })

    expect((await accountUsage(sessionID, 1_000))?.tokensUsed).toBe(0)
    expect((await accountUsage(sessionID, 1_025))?.tokensUsed).toBe(25)
    expect((await accountUsage(sessionID, 1_010))?.tokensUsed).toBe(25)

    // Compaction lowers the cumulative session total. Keep goal usage monotonic, then
    // measure growth from the new cumulative base.
    expect((await accountUsage(sessionID, 100))?.tokensUsed).toBe(25)
    expect((await accountUsage(sessionID, 130))?.tokensUsed).toBe(55)
  })

  test("persists and replaces the creation cursor without charging pre-existing context", async () => {
    await isolated()
    const sessionID = "replacement"
    await createGoal(sessionID, "first", { sessionTokensAtCreation: 500 })
    await accountUsage(sessionID, 525)
    expect((await readState()).goals[sessionID].sessionTokensAtCreation).toBe(500)
    expect((await getGoal(sessionID))?.tokensUsed).toBe(25)

    await completeGoal(sessionID, "first complete")
    const replacement = await createGoal(sessionID, "second", { sessionTokensAtCreation: 525 })
    expect(replacement.tokensUsed).toBe(0)
    expect((await readState()).goals[sessionID].sessionTokensAtCreation).toBe(525)
    expect((await accountUsage(sessionID, 540))?.tokensUsed).toBe(15)
  })

  test("new goals start at zero when creation-time context is unavailable", async () => {
    await isolated()
    const sessionID = "unknown-creation-context"
    await createGoal(sessionID, "start at zero")
    expect((await accountUsage(sessionID, 1_000))?.tokensUsed).toBe(0)
    expect((await accountUsage(sessionID, 1_025))?.tokensUsed).toBe(25)
  })

  test("legacy goals without a cursor preserve usage and start counting future deltas", async () => {
    await isolated()
    const sessionID = "legacy"
    await createGoal(sessionID, "legacy", { sessionTokensAtCreation: 0 })
    await accountUsage(sessionID, 100)
    const state = await readState()
    delete state.goals[sessionID].sessionTokensAtCreation
    delete state.goals[sessionID].lastSessionTokens
    await Bun.write(process.env.OPENCODE_GOAL_STATE_PATH!, JSON.stringify(state))

    expect((await accountUsage(sessionID, 100))?.tokensUsed).toBe(100)
    expect((await accountUsage(sessionID, 115))?.tokensUsed).toBe(115)
  })

  test("token boundary limits, explicit extension preserves cumulative evidence", async () => {
    await isolated()
    const sessionID = "token-boundary"
    await createGoal(sessionID, "finish the migration", { tokenBudget: 10, maxAutoTurns: 2, sessionTokensAtCreation: 0 })
    await accountUsage(sessionID, 10)
    const limited = await getGoal(sessionID)
    expect(limited?.status).toBe("budgetLimited")
    expect(limited?.stopReason).toContain("token budget reached")
    const beforeHistory = limited!.history.length
    const beforeCheckpoint = limited!.lastCheckpoint

    const extended = await extendGoal(sessionID, { tokenBudget: 100 })
    expect(extended.status).toBe("active")
    expect(extended.tokensUsed).toBe(10)
    expect(extended.tokenBudget).toBe(100)
    expect(extended.autoTurns).toBe(0)
    expect(extended.history.length).toBe(beforeHistory + 1)
    expect(extended.history.at(-1)?.type).toBe("extended")
    expect(extended.lastCheckpoint).toEqual(beforeCheckpoint)
  })

  test("ordinary resume cannot bypass an exhausted limit", async () => {
    await isolated()
    await createGoal("ordinary-resume", "stay bounded", { tokenBudget: 1, sessionTokensAtCreation: 0 })
    await accountUsage("ordinary-resume", 1)
    await expect(setGoalStatus("ordinary-resume", "active")).rejects.toThrow("explicitly extend")
    await expect(updateGoalObjective("ordinary-resume", "new objective", "active")).rejects.toThrow("explicitly extend")
  })

  // The turn cap is the third limit, and it was the only one the resume guard skipped. The budget and
  // the duration are both re-checked by `exhaustGoalLimits` before a goal may go back to `active`, so
  // resuming an exhausted one throws "explicitly extend". The turn cap reached the same
  // `maybeStopForUsageLimit` call - but with the UNBOUNDED default hardcoded instead of the caller's,
  // so its turn-cap branch was inert and only the duration branch could ever trip.
  //
  // The result was a goal that reported a successful resume it could not honour. A goal with a
  // 2-turn cap that spent both turns, then paused and resumed, came back `active` with
  // lastStatus "Goal resumed." - and then could do neither of the two things that status implies: the
  // next `reserveContinuation` found `autoTurns >= maxAutoTurns` and immediately limited it, and
  // `extendGoal` refused it outright ("only a limited goal can be explicitly extended") because the
  // status was `active`, not `usageLimited`. So the user's resume silently undid itself and left the
  // only documented remedy unreachable.
  test("a resume cannot bypass an exhausted auto-continue cap either", async () => {
    await isolated()
    const sessionID = "turn-cap-resume"
    await createGoal(sessionID, "bounded turns", { maxAutoTurns: 2 })
    await reserveContinuation(sessionID, 0, 0)
    await reserveContinuation(sessionID, 0, 0)
    expect((await getGoal(sessionID))?.autoTurns).toBe(2)

    await setGoalStatus(sessionID, "paused")
    // The refusal has to COMMIT the limited status, not just throw: `mutateStatus` writes the
    // transition and then raises. A goal left `paused` here would be neither resumable nor
    // extendable, which is the wedge this closes.
    await expect(setGoalStatus(sessionID, "active")).rejects.toThrow("explicitly extend")
    const limited = await getGoal(sessionID)
    expect(limited?.status).toBe("usageLimited")
    expect(limited?.stopReason).toContain("max auto-continues reached")

    // ...and the documented remedy is reachable again, which is what the bad resume destroyed.
    const extended = await extendGoal(sessionID, { maxAutoTurns: 5 })
    expect(extended.status).toBe("active")
    expect(extended.maxAutoTurns).toBe(5)
  })

  test("a goal with no turn cap is still resumable after spending many turns", async () => {
    await isolated()
    const sessionID = "unbounded-turns"
    // `maxAutoTurns: null` means "no cap", so an arbitrary number of reservations must not make the
    // goal unresumable - the control for the test above, which would also "pass" a guard that simply
    // refused every resume.
    await createGoal(sessionID, "unbounded", { maxAutoTurns: null })
    for (let i = 0; i < 5; i++) await reserveContinuation(sessionID, 0, 0)
    expect((await getGoal(sessionID))?.autoTurns).toBe(5)

    await setGoalStatus(sessionID, "paused")
    const resumed = await setGoalStatus(sessionID, "active")
    expect(resumed.status).toBe("active")
  })

  test("closed and lower extensions are rejected", async () => {
    await isolated()
    await createGoal("closed", "done", { tokenBudget: 1, sessionTokensAtCreation: 0 })
    await accountUsage("closed", 1)
    await expect(extendGoal("closed", { tokenBudget: 0 })).rejects.toThrow("positive integer")
    await extendGoal("closed", { tokenBudget: 2 })
    await completeGoal("closed", "evidence")
    await expect(extendGoal("closed", { tokenBudget: 3 })).rejects.toThrow("closed goal")
    await expect(setGoalStatus("closed", "active")).rejects.toThrow("closed goal")
    await expect(updateGoalObjective("closed", "new objective", "active")).rejects.toThrow("closed goal")

    await createGoal("unmet", "blocked", { tokenBudget: 1 })
    await markGoalUnmet("unmet", "external blocker")
    await expect(setGoalStatus("unmet", "active")).rejects.toThrow("closed goal")
    await expect(updateGoalObjective("unmet", "new objective", "active")).rejects.toThrow("closed goal")

    await createGoal("reopen-new", "first", { tokenBudget: 1 })
    await completeGoal("reopen-new", "first complete")
    const replacement = await createGoal("reopen-new", "second", { tokenBudget: 10 })
    expect(replacement.objective).toBe("second")

    await createGoal("lower", "lower", { tokenBudget: 10, sessionTokensAtCreation: 0 })
    await accountUsage("lower", 10)
    await expect(extendGoal("lower", { tokenBudget: 1 })).rejects.toThrow("higher")
  })

  test("turn limit and no-progress pause remain bounded", async () => {
    await isolated()
    await createGoal("turns", "turn limited", { maxAutoTurns: 1 })
    expect((await reserveContinuation("turns", 25, 0))?.status).toBe("active")
    expect((await reserveContinuation("turns", 25, 0))?.status).toBe("usageLimited")
    expect((await getGoal("turns"))?.stopReason).toContain("max auto-continues")

    await createGoal("progress", "no progress", { maxAutoTurns: 5 })
    await reserveContinuation("progress", 25, 0)
    await recordContinuationResult("progress", "success", 3)
    await recordAssistantProgress("progress", { messageID: "first", text: "same", outputTokens: 1, evaluateContinuation: true })
    await reserveContinuation("progress", 25, 0)
    await recordContinuationResult("progress", "success", 3)
    await recordAssistantProgress("progress", { messageID: "second", text: "same", outputTokens: 1, evaluateContinuation: true })
    await reserveContinuation("progress", 25, 0)
    await recordContinuationResult("progress", "success", 3)
    await recordAssistantProgress("progress", { messageID: "third", text: "same", outputTokens: 1, evaluateContinuation: true })
    expect((await getGoal("progress"))?.status).toBe("paused")
  })

  test("a null maxAutoTurns goal is never capped when the default is unbounded", async () => {
    await isolated()
    // Mirrors the plugin's DEFAULT_MAX_AUTO_TURNS = 0: an unlimited /goal must keep
    // reserving continuations past the old implicit 25-turn cap.
    const UNBOUNDED = 0
    await createGoal("unlimited", "no limits", { maxAutoTurns: null })
    for (let i = 0; i < 30; i++) {
      expect((await reserveContinuation("unlimited", UNBOUNDED, 0))?.status).toBe("active")
    }
    const goal = await getGoal("unlimited")
    expect(goal?.status).toBe("active")
    expect(goal?.autoTurns).toBe(30)
    expect(goal?.tokenBudget).toBeNull()
    expect(goal?.maxDurationSeconds).toBeNull()
    expect(goal?.stopReason).toBeNull()
  })
})

test("explicit null overrides configured token and duration defaults", () => {
  expect(resolveCreateGoalLimits({ objective: "x", token_budget: null, max_duration_seconds: null }, { default_token_budget: 10, max_goal_duration_seconds: 20 })).toEqual({
    tokenBudget: null,
    maxAutoTurns: null,
    maxDurationSeconds: null,
  })
  expect(resolveCreateGoalLimits({ objective: "x" }, { default_token_budget: 10, max_goal_duration_seconds: 20 })).toEqual({
    tokenBudget: 10,
    maxAutoTurns: null,
    maxDurationSeconds: 20,
  })
})
