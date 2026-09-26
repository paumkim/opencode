import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createGoal,
  getGoal,
  recordAssistantProgress,
  recordContinuationResult,
  recordGoalCompletion,
  reserveContinuation,
  statePath,
} from "@/goal/impl"
import { continuationPrompt } from "@/goal/prompts"

let stateDir: string | undefined
const previous = process.env.OPENCODE_GOAL_STATE_PATH

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "opencode-goal-ledger-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(stateDir, "goals.json")
})

afterEach(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true })
  stateDir = undefined
  if (previous === undefined) delete process.env.OPENCODE_GOAL_STATE_PATH
  else process.env.OPENCODE_GOAL_STATE_PATH = previous
})

/**
 * One continuation turn: reserve it, report the prompt succeeded, then score the turn.
 * `onTurn` runs between the reservation and the scoring, which is where a real turn records a
 * completion.
 */
async function turn(sessionID: string, id: string, opts: { toolCalls?: number; onTurn?: () => Promise<void> } = {}) {
  await reserveContinuation(sessionID, 0, 0)
  await recordContinuationResult(sessionID, "success", 3)
  await opts.onTurn?.()
  await recordAssistantProgress(sessionID, {
    messageID: id,
    text: "same",
    outputTokens: 1,
    toolCalls: opts.toolCalls ?? 0,
    evaluateContinuation: true,
  })
}

describe("the completed-work ledger", () => {
  test("records finished work in order and survives a reload", async () => {
    const sessionID = "ledger-1"
    await createGoal(sessionID, "keep improving", { maxAutoTurns: 100 })

    await recordGoalCompletion(sessionID, "fixed the overflow retry backoff")
    await recordGoalCompletion(sessionID, "added a regression test for prompt trimming")

    const goal = await getGoal(sessionID)
    expect(goal?.completed).toEqual([
      "fixed the overflow retry backoff",
      "added a regression test for prompt trimming",
    ])

    // It has to be on disk, not just in memory: the ledger is what survives a restart, which is the
    // whole point. A fresh read of the state file is the only honest check.
    const raw = JSON.parse(await Bun.file(statePath()).text())
    expect(raw.goals[sessionID].completed).toHaveLength(2)
  })

  test("re-recording the same work is a no-op, whatever the capitalisation", async () => {
    const sessionID = "ledger-2"
    await createGoal(sessionID, "keep improving", { maxAutoTurns: 100 })

    await recordGoalCompletion(sessionID, "fixed the parser")
    await recordGoalCompletion(sessionID, "  Fixed The Parser  ")

    // A ledger that grows every time the same work is re-reported re-creates the very loop it
    // exists to break, and it would read to the model as though that work were never finished.
    expect((await getGoal(sessionID))?.completed).toEqual(["fixed the parser"])
  })

  test("rejects an empty item", async () => {
    const sessionID = "ledger-3"
    await createGoal(sessionID, "keep improving", { maxAutoTurns: 100 })
    expect(recordGoalCompletion(sessionID, "   ")).rejects.toThrow()
  })
})

describe("the continuation prompt carries the ledger", () => {
  test("names what is finished and tells the model to move on", async () => {
    const sessionID = "ledger-4"
    await createGoal(sessionID, "find further bugs and fix them", { maxAutoTurns: 100 })
    await recordGoalCompletion(sessionID, "fixed the retry backoff")

    const goal = await getGoal(sessionID)
    expect(goal).not.toBeNull()
    const prompt = continuationPrompt(goal!)

    // The bug being fixed: the prompt carried the objective and the budget and nothing else, while
    // telling the model to distrust its own prior context. Nothing in it said what was already done,
    // so an open-ended objective was re-derived from the repo every turn.
    expect(prompt).toContain("fixed the retry backoff")
    expect(prompt).toContain("record_goal_completion")
    expect(prompt).toContain("do NOT redo any of this")
    expect(prompt).toContain("update_goal")
  })

  test("a goal with nothing recorded still prompts, and asks for the first entry", async () => {
    const sessionID = "ledger-5"
    await createGoal(sessionID, "find further bugs", { maxAutoTurns: 100 })
    const prompt = continuationPrompt((await getGoal(sessionID))!)
    expect(prompt).toContain("(nothing recorded yet)")
    expect(prompt).toContain("record_goal_completion")
  })
})

describe("stall detection can see a loop", () => {
  // The reported failure: both unattended goals sat at noProgressTurns 0 while visibly re-fixing
  // the same defect turn after turn. The scorer could not see it because a looping turn uses tools
  // AND narrates, and tool use alone reset the counter every time.
  test("a tool-heavy turn that closes nothing out is scored as no progress", async () => {
    const sessionID = "loop-1"
    await createGoal(sessionID, "find further bugs", { maxAutoTurns: 100 })
    await recordGoalCompletion(sessionID, "fixed the parser")

    // Turn one primes the baseline (its text differs from the empty baseline), so the stall has to
    // be observed on the turns after it.
    await turn(sessionID, "a", { toolCalls: 6 })
    expect((await getGoal(sessionID))?.noProgressTurns).toBe(0)

    await turn(sessionID, "b", { toolCalls: 6 })
    expect((await getGoal(sessionID))?.noProgressTurns).toBe(1)

    await turn(sessionID, "c", { toolCalls: 6 })
    const stalled = await getGoal(sessionID)
    expect(stalled?.noProgressTurns).toBe(2)
    expect(stalled?.status).toBe("paused")
    expect(stalled?.stopReason).toBe("no progress")
  })

  test("a tool-heavy turn that records a completion is still progress", async () => {
    const sessionID = "loop-2"
    await createGoal(sessionID, "find further bugs", { maxAutoTurns: 100 })
    await recordGoalCompletion(sessionID, "fixed the parser")

    await turn(sessionID, "a", { toolCalls: 6 })
    await turn(sessionID, "b", {
      toolCalls: 6,
      onTurn: async () => {
        await recordGoalCompletion(sessionID, "fixed the guard")
      },
    })
    await turn(sessionID, "c", {
      toolCalls: 6,
      onTurn: async () => {
        await recordGoalCompletion(sessionID, "covered the guard")
      },
    })

    // The regression this must not introduce: a real unit of work closes itself out, so the ledger
    // moves and the turn counts as progress even though it narrates the same text every time.
    const goal = await getGoal(sessionID)
    expect(goal?.status).toBe("active")
    expect(goal?.noProgressTurns).toBe(0)
    expect(goal?.completed).toHaveLength(3)
  })

  test("a goal that keeps no ledger is scored exactly as before", async () => {
    // Scoped deliberately: penalising an agent that never records anything would change stall
    // detection for every existing goal, including ones whose work is not itemisable.
    const sessionID = "loop-3"
    await createGoal(sessionID, "find further bugs", { maxAutoTurns: 100 })

    await turn(sessionID, "a", { toolCalls: 6 })
    await turn(sessionID, "b", { toolCalls: 6 })
    await turn(sessionID, "c", { toolCalls: 6 })
    await turn(sessionID, "d", { toolCalls: 6 })

    const goal = await getGoal(sessionID)
    expect(goal?.status).toBe("active")
    expect(goal?.noProgressTurns).toBe(0)
  })
})
