import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  accountUsage,
  completeGoal,
  createGoal,
  getGoal,
  markGoalUnmet,
  recordAssistantProgress,
  recordContinuationResult,
  recordGoalCompletion,
  reserveContinuation,
  setGoalStatus,
  statePath,
} from "@/goal/impl"
import { continuationPrompt } from "@/goal/prompts"
import { GOAL_MAX_COMPLETED_ITEMS } from "@/goal/schema"
import { goalTools } from "@/goal/tools"
import { Effect } from "effect"

/**
 * Runs one goal tool the way the model does and returns its raw output string, so the test can
 * assert on what the model is actually told - not on the implementation returning a value the tool
 * then swallows.
 */
async function runTool(tool: string, args: unknown, sessionID: string) {
  const tools = goalTools({
    client: { session: { messages: () => ({ data: [] }) } } as never,
    options: {},
    agent: { get: () => Effect.succeed({} as never) } as never,
    truncate: {
      output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
    } as never,
  })
  const result = await Effect.runPromise(
    tools[tool].execute(args as never, {
      sessionID,
      messageID: "msg-1",
      agent: "build",
      abort: new AbortController().signal,
    } as never),
  )
  return result.output
}

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

  test("the tool tells the model when a record was not kept", async () => {
    const sessionID = "ledger-paused"
    await createGoal(sessionID, "keep improving", { maxAutoTurns: 100 })
    await setGoalStatus(sessionID, "paused")

    // The bug: `recordGoalCompletion` only records onto an ACTIVE goal, and for any other status it
    // returns the goal snapshot. The tool tests only `if (!goal)`, and a snapshot is truthy, so a
    // record against a paused/limited/closed goal came back as a success-shaped `{goal}` payload
    // while the ledger was untouched. The model is told to call this tool the moment a unit is done
    // and that recording nothing pauses the goal for no progress - so it believes it closed the unit
    // out, the next turn's ledger does not list it, and the work is redone. That is precisely the
    // loop the ledger exists to prevent, and the tool is what makes it invisible.
    const output = await runTool("record_goal_completion", { item: "fixed the retry backoff" }, sessionID)

    expect(output).toContain("nothing was recorded")
    expect(output).not.toContain('"status": "paused"')
    expect((await getGoal(sessionID))?.completed).toEqual([])
  })

  test("the tool still reports a genuine record as recorded", async () => {
    const sessionID = "ledger-active"
    await createGoal(sessionID, "keep improving", { maxAutoTurns: 100 })

    // The control for the test above: on an active goal the record IS kept, so the tool must not
    // report "nothing was recorded" - otherwise a fix that always refuses would pass both tests.
    const output = await runTool("record_goal_completion", { item: "fixed the retry backoff" }, sessionID)

    expect(output).not.toContain("nothing was recorded")
    expect((await getGoal(sessionID))?.completed).toEqual(["fixed the retry backoff"])
  })

  // The failure: `limitPrompt` is sent ONLY for a budgetLimited/usageLimited goal and it ends with
  // "call record_goal_completion once for each unit you actually finished and verified in this
  // session" - while `recordGoalCompletion` recorded onto `active` alone. The goal system's own
  // wrap-up prompt was therefore a no-op: the tool answered "nothing was recorded", and the last
  // units of work before the limit tripped vanished from the only durable record of them. The next
  // turn is handed the ledger instead of the transcript, so it cannot tell finished work from
  // interrupted work and redoes it.
  test("a budget-limited goal still accepts the record its wrap-up prompt asks for", async () => {
    const sessionID = "ledger-budget-limited"
    // A real tripped limit rather than a hand-built status: `maybeStopForBudget` is what the runtime
    // would have produced, so this is the goal the driver actually sends the wrap-up prompt for.
    await createGoal(sessionID, "keep improving", { tokenBudget: 1_000, maxAutoTurns: 0, sessionTokensAtCreation: 0 })
    await accountUsage(sessionID, 1_500)
    expect((await getGoal(sessionID))?.status).toBe("budgetLimited")

    const output = await runTool("record_goal_completion", { item: "built the export affordance" }, sessionID)

    expect(output).not.toContain("nothing was recorded")
    const goal = await getGoal(sessionID)
    expect(goal?.completed).toEqual(["built the export affordance"])
    // Widening the gate must not resurrect the goal: recording is the ONLY thing allowed here, so the
    // limited status, its stopReason and the "extend before resuming" shape all have to survive a
    // record. A record that flipped the status back to `active` would walk straight past the guard
    // `setGoalStatus` enforces, and past `extendGoal`'s eligibility.
    expect(goal?.status).toBe("budgetLimited")
    expect(goal?.stopReason).toContain("token budget reached")
  })

  // The same failure on the OTHER limit: `reserveContinuation` routes budgetLimited and usageLimited
  // to the same wrap-up prompt, so a turn cap or a duration cap that trips on the last unit of work
  // loses that unit exactly as a token budget does.
  test("a usage-limited goal still accepts the record its wrap-up prompt asks for", async () => {
    const sessionID = "ledger-usage-limited"
    // `maxAutoTurns: 0` means unbounded, so a usage limit needs a real cap, and
    // `maybeStopForUsageLimit` is checked BEFORE the increment - hence two reservations to trip it.
    await createGoal(sessionID, "keep improving", { maxAutoTurns: 1 })
    await reserveContinuation(sessionID, 1, 0)
    await reserveContinuation(sessionID, 1, 0)
    expect((await getGoal(sessionID))?.status).toBe("usageLimited")

    await runTool("record_goal_completion", { item: "ported the tokenizer to the new API" }, sessionID)

    const goal = await getGoal(sessionID)
    expect(goal?.completed).toEqual(["ported the tokenizer to the new API"])
    expect(goal?.status).toBe("usageLimited")
  })

  // The half of the gate that must NOT move with the limit. A finished goal's ledger is what a
  // completion audit reads back, and a record landing after `complete`/`unmet` would make that audit
  // non-reproducible: the same finished goal would report different completed work depending on
  // whether the wrap-up turn happened to call this tool. Both closed statuses are checked because
  // `isClosed` is the one thing both share, and the tool must name which one refused.
  test("a finished goal still refuses the record", async () => {
    const cases = [
      { status: "complete", sessionID: "ledger-complete" },
      { status: "unmet", sessionID: "ledger-unmet" },
    ] as const

    for (const { status, sessionID } of cases) {
      await createGoal(sessionID, "keep improving", { maxAutoTurns: 100 })
      if (status === "complete") await completeGoal(sessionID, "verified in the worktree")
      else await markGoalUnmet(sessionID, "the upstream API does not exist")
      expect((await getGoal(sessionID))?.status).toBe(status)

      const output = await runTool("record_goal_completion", { item: "fixed the retry backoff" }, sessionID)

      expect(output).toContain("nothing was recorded")
      // The refusal has to name the status, or the model is told a record was dropped without being
      // told why and re-issues it against whatever goal it thinks is current.
      expect(output).toContain(status)
      expect((await getGoal(sessionID))?.completed).toEqual([])
    }
  })

  test("a full ledger still records the new item instead of calling it a no-op", async () => {
    const sessionID = "ledger-full"
    await createGoal(sessionID, "keep improving", { maxAutoTurns: 100 })
    for (let i = 0; i < GOAL_MAX_COMPLETED_ITEMS; i++) await recordGoalCompletion(sessionID, `item ${i}`)

    const atCap = await getGoal(sessionID)
    expect(atCap?.completed).toHaveLength(GOAL_MAX_COMPLETED_ITEMS)

    const recorded = await recordGoalCompletion(sessionID, "one past the cap")

    // The bug: the ledger is capped by dropping the OLDEST entry, so its length is unchanged by a
    // new item once the cap is reached. Treating "length did not change" as "nothing was recorded"
    // therefore threw away the checkpoint, the history entry, and - below - the loop guard's only
    // evidence that this turn closed real work out. The model is told "call record_goal_completion
    // the moment a unit is done" and gets a silent no-op for every unit from the 41st on.
    expect(recorded?.completed.at(-1)).toBe("one past the cap")
    expect(recorded?.lastCheckpoint?.summary).toContain("one past the cap")
  })

  test("a goal that keeps finishing work is not scored as a loop once its ledger is full", async () => {
    const sessionID = "ledger-full-loop"
    await createGoal(sessionID, "find further bugs", { maxNoProgressTurns: 2, maxAutoTurns: 100 })
    for (let i = 0; i < GOAL_MAX_COMPLETED_ITEMS; i++) await recordGoalCompletion(sessionID, `item ${i}`)

    // Same root cause, and the consequence that actually stops an unattended run: the stall scorer
    // reads "the ledger did not grow", and at the cap it never grows, so every later turn that
    // genuinely records a completion is scored as the loop it is not. The goal then pauses itself
    // for "no progress" while doing exactly what it was told to do.
    for (const id of ["a", "b", "c", "d"]) {
      await turn(sessionID, id, {
        toolCalls: 6,
        onTurn: async () => {
          await recordGoalCompletion(sessionID, `fixed the ${id} defect`)
        },
      })
    }

    const goal = await getGoal(sessionID)
    expect(goal?.status).toBe("active")
    expect(goal?.noProgressTurns).toBe(0)
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

  test("a goal that records work every turn is not paused, in the order the driver runs them", async () => {
    // The order matters, and the helper above does NOT model it. In production `runAutoContinue`
    // scores the turn that just finished and only then reserves the next continuation, while the
    // model's own `record_goal_completion` call for that turn lands DURING the turn - i.e. before the
    // scoring. So the real sequence per turn is: record, then score, then reserve. Getting it
    // backwards (score, then record) makes the ledger look frozen for one extra turn and pauses a
    // goal that did everything it was asked to, so the order is pinned here explicitly rather than
    // left to whichever helper a test happens to use.
    const sessionID = "loop-4"
    await createGoal(sessionID, "find further bugs", { maxAutoTurns: 100, maxNoProgressTurns: 2 })
    await recordGoalCompletion(sessionID, "fixed the parser")

    for (const id of ["a", "b", "c", "d", "e"]) {
      // The model's record for the turn it just finished, landing before the turn is scored.
      await recordGoalCompletion(sessionID, `finished unit ${id}`)
      // Then the scoring call `runAutoContinue` makes, then the reservation.
      await recordAssistantProgress(sessionID, {
        messageID: id,
        text: "same",
        outputTokens: 1,
        toolCalls: 6,
        evaluateContinuation: true,
      })
      const reserved = await reserveContinuation(sessionID, 0, 0)
      expect(reserved).not.toBeNull()
      await recordContinuationResult(sessionID, "success", 3)
    }

    const goal = await getGoal(sessionID)
    expect(goal?.status).toBe("active")
    expect(goal?.noProgressTurns).toBe(0)
    expect(goal?.completedRecorded).toBe(6)
  })
})
