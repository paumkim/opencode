import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  accountUsage,
  completeGoal,
  createGoal,
  extendGoal,
  getGoal,
  readState,
  recordContinuationResult,
  pauseGoalForPlanMode,
  recordAssistantProgress,
  recordPromptAgent,
  reserveContinuation,
  setGoalStatus,
  statePath,
  updateGoalObjective,
} from "@/goal/impl"
import { GOAL_CHECKPOINT_CHAR_LIMIT, GOAL_MAX_RETAINED_TEXT } from "@/goal/schema"

let stateDir: string | undefined
const previous = process.env.OPENCODE_GOAL_STATE_PATH

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "opencode-goal-limit-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(stateDir, "goals.json")
})

afterEach(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true })
  stateDir = undefined
  if (previous === undefined) delete process.env.OPENCODE_GOAL_STATE_PATH
  else process.env.OPENCODE_GOAL_STATE_PATH = previous
})

describe("H30: a mutation that changes nothing must not rewrite the state file", () => {
  // Goal state is ONE global file shared by every project and every session the user has ever run
  // goal mode in, and only an explicit `clear_goal` ever removes an entry. Each assistant message
  // mutates it two or three times (`accountUsage`, `recordAssistantProgress`, then the scored
  // progress call), and every write serialized the whole file. Measured on this machine: one
  // read+decode+serialize+write cycle cost 4ms at 10 stored goals, 110ms at 500, 217ms at 1000 and
  // 447ms at 2000 - so a no-op mutation wrote back identical bytes and paid all of it.
  //
  // Scope: skipping the write is worth only 4-6% of that cycle (217ms -> 208ms at 1000), because
  // serializing the whole state IS the cost and the comparison has to serialize too. What it does
  // remove is the write/rename/chmod syscalls and the mtime churn, which is what this test pins.
  const mtimeOf = async () => (await Bun.file(statePath()).stat()).mtimeMs
  const contentOf = async () => await Bun.file(statePath()).text()

  test("an unchanged state leaves the file's bytes and modification time alone", async () => {
    const sessionID = "h30-closed"
    await createGoal(sessionID, "finished work", { maxAutoTurns: 10 })
    await completeGoal(sessionID, "verified in the worktree")
    const before = await contentOf()
    const mtimeBefore = await mtimeOf()

    // A closed goal is immutable, so every one of these is a no-op by construction - which is
    // exactly the shape that used to pay for a full rewrite. Several in a row, because the point is
    // that none of them touches the file.
    for (let i = 0; i < 5; i++) {
      await accountUsage(sessionID, 999_999)
      await recordAssistantProgress(sessionID, { messageID: "m", text: "still talking", outputTokens: 900 })
      await recordContinuationResult(sessionID, "failure", 5)
    }

    // Byte equality ALONE would also hold if something rewrote identical bytes, so the modification
    // time is the assertion that actually distinguishes "skipped the write" from "wrote the same
    // bytes again". It is sampled before the mutations, not re-read against itself.
    expect(await contentOf()).toBe(before)
    expect(await mtimeOf()).toBe(mtimeBefore)
    const state = await readState()
    expect(state.goals[sessionID]?.status).toBe("complete")
    expect(state.goals[sessionID]?.completionEvidence).toBe("verified in the worktree")
  })

  test("a mutation that DOES change the state still writes it", async () => {
    // The control that makes the test above mean something: skipping the write must not become
    // skipping the persistence. Each of these has to land on disk.
    const sessionID = "h30-active"
    await createGoal(sessionID, "live work", { maxAutoTurns: 10, sessionTokensAtCreation: 0 })

    await accountUsage(sessionID, 1_000)
    expect((await readState()).goals[sessionID]?.tokensUsed).toBe(1_000)

    await recordAssistantProgress(sessionID, { messageID: "m1", text: "checkpoint me", outputTokens: 900 })
    expect((await readState()).goals[sessionID]?.lastAssistantMessageID).toBe("m1")

    await setGoalStatus(sessionID, "paused")
    expect((await readState()).goals[sessionID]?.status).toBe("paused")

    // And the write has to be a real, complete one - not a partial or truncated file.
    const text = await contentOf()
    expect(() => JSON.parse(text)).not.toThrow()
    expect(text.endsWith("\n")).toBe(true)
  })

  test("a normalizing repair of a legacy field still rewrites the file", async () => {
    // The comparison is byte-for-byte against what was read, which is what makes the skip safe: a
    // value `normalizeGoal` repairs differs from disk, so it must still be persisted rather than
    // being written back verbatim. A legacy goal with a fractional `tokensUsed` is exactly that.
    const sessionID = "h30-legacy"
    await createGoal(sessionID, "legacy goal", { maxAutoTurns: 10 })
    const raw = JSON.parse(await contentOf())
    raw.goals[sessionID].tokensUsed = 12.5
    await Bun.write(statePath(), JSON.stringify(raw, null, 2))

    // Any mutation at all must normalize and persist the repair, not keep the bad value on disk.
    await setGoalStatus(sessionID, "paused")
    const after = JSON.parse(await contentOf())
    expect(after.goals[sessionID].tokensUsed).toBe(0)
  })
})

describe("a goal refused for an exhausted limit must still be extendable", () => {
  // Control: the same end state (500 used against a 100 budget) reached WITHOUT a pause is
  // marked budgetLimited and extends cleanly. That is what proves the paused path below is a
  // defect rather than a deliberate policy.
  test("control: the same usage reached while active is budgetLimited and extendable", async () => {
    const sessionID = "not-wedged"
    await createGoal(sessionID, "bounded work", { tokenBudget: 100, sessionTokensAtCreation: 0 })
    await accountUsage(sessionID, 500)
    expect((await getGoal(sessionID))?.status).toBe("budgetLimited")

    const extended = await extendGoal(sessionID, { tokenBudget: 1_000 })
    expect(extended.status).toBe("active")
    expect(extended.tokensUsed).toBe(500)
  })

  test("a goal that outgrew its budget while paused is left limited, not stuck in paused", async () => {
    const sessionID = "wedged-token"
    await createGoal(sessionID, "bounded work", { tokenBudget: 100, sessionTokensAtCreation: 0 })

    // Pause, then let the session keep spending. `maybeStopForBudget` only acts on an active
    // goal, so the overage accumulates on a goal that is still "paused".
    await setGoalStatus(sessionID, "paused")
    await accountUsage(sessionID, 500)
    const over = await getGoal(sessionID)
    expect(over?.tokensUsed).toBe(500)

    // The resume guard fires...
    await expect(setGoalStatus(sessionID, "active")).rejects.toThrow("explicitly extend")

    // ...but it leaves the goal in "paused" instead of performing the transition it clearly
    // intends. impl.ts calls `maybeStopForBudget(goal)`, which early-returns for any non-active
    // goal, and the throw on the next line would discard the mutation anyway, because `mutate`
    // only writes after the callback returns.
    const goal = await getGoal(sessionID)
    expect(goal?.status).toBe("budgetLimited")
    expect(goal?.stopReason).toContain("token budget reached")
  })

  test("the extension the error message names is actually reachable afterwards", async () => {
    const sessionID = "wedged-remedy"
    await createGoal(sessionID, "bounded work", { tokenBudget: 100, sessionTokensAtCreation: 0 })
    await setGoalStatus(sessionID, "paused")
    await accountUsage(sessionID, 500)
    await expect(setGoalStatus(sessionID, "active")).rejects.toThrow("explicitly extend")

    // The rejection instructs the operator to "explicitly extend its limits before resuming",
    // but `extendGoal` accepts only a budgetLimited/usageLimited goal. The goal is therefore
    // wedged: it can neither be resumed nor extended, and the only escape is clear_goal, which
    // discards history and cumulative usage.
    const extended = await extendGoal(sessionID, { tokenBudget: 1_000 })
    expect(extended.status).toBe("active")
    expect(extended.tokensUsed).toBe(500)
    expect(extended.tokenBudget).toBe(1_000)
  })

  test("the same wedge does not happen for an exhausted duration limit", async () => {
    const sessionID = "wedged-duration"
    await createGoal(sessionID, "bounded time", { maxDurationSeconds: 1, sessionTokensAtCreation: 0 })
    await setGoalStatus(sessionID, "paused")

    // Spend the second the goal is paused: `accountWallClock` does not run for a paused goal, so
    // drive usage accounting with a budget the goal does not have, then let the wall clock pass.
    const file = (await import("@/goal/impl")).statePath()
    const raw = JSON.parse(await Bun.file(file).text())
    raw.goals[sessionID].timeUsedSeconds = 60
    await Bun.write(file, JSON.stringify(raw, null, 2))

    await expect(setGoalStatus(sessionID, "active")).rejects.toThrow("explicitly extend")

    const extended = await extendGoal(sessionID, { maxDurationSeconds: 3_600 })
    expect(extended.status).toBe("active")
  })

  test("editing the objective cannot bypass the guard a plain resume obeys", async () => {
    const sessionID = "objective-bypass"
    await createGoal(sessionID, "bounded work", { tokenBudget: 100, sessionTokensAtCreation: 0 })
    await setGoalStatus(sessionID, "paused")
    await accountUsage(sessionID, 500)

    // Editing the objective with status "active" is a reactivation, so it has to refuse exactly
    // like `setGoalStatus(active)` does. It used to reactivate straight past the limit check.
    await expect(updateGoalObjective(sessionID, "new objective", "active")).rejects.toThrow("explicitly extend")
    expect((await getGoal(sessionID))?.status).toBe("budgetLimited")
    expect((await getGoal(sessionID))?.objective).toBe("bounded work")

    // And a paused edit still works, so the guard is scoped to reactivation only.
    const edited = await updateGoalObjective(sessionID, "new objective", "paused")
    expect(edited.status).toBe("paused")
    expect(edited.objective).toBe("new objective")
  })
})

describe("H15: the retained assistant text is bounded", () => {
  // `lastAssistantText` is the full text of the most recent assistant message. Every internal use
  // passes it through `summarizeText`, which keeps 280 characters, and no consumer outside this
  // file reads it. But it is stored verbatim and `accountUsage` re-serializes the whole state file
  // on EVERY LLM step, so a verbose turn is paid for again on every step of the turn that follows -
  // and `get_goal` echoes the whole thing into the model's context.
  const VERBOSE = "word ".repeat(10_000) // 50,000 characters

  test("a verbose turn does not leave an unbounded field in the state file", async () => {
    const sessionID = "h15-verbose"
    await createGoal(sessionID, "verbose agent", { maxAutoTurns: 0 })

    await recordAssistantProgress(sessionID, { messageID: "m1", text: VERBOSE })

    const persisted = JSON.parse(await Bun.file(statePath()).text())
    expect(persisted.goals[sessionID].lastAssistantText.length).toBeLessThanOrEqual(GOAL_MAX_RETAINED_TEXT)
  })

  test("the checkpoint summary is still built from the start of the message", async () => {
    // The bound must not cost the checkpoint its content. Assert the properties that matter -
    // the message prefix survives, the summary stays short, and truncation is still marked - rather
    // than restating the truncation arithmetic here.
    const sessionID = "h15-summary"
    await createGoal(sessionID, "verbose agent", { maxAutoTurns: 0 })

    await recordAssistantProgress(sessionID, { messageID: "m1", text: VERBOSE })

    const summary = await getGoal(sessionID).then((goal) => goal?.lastCheckpoint?.summary ?? "")
    expect(summary.startsWith("word word word word")).toBe(true)
    expect(summary.length).toBeLessThanOrEqual(GOAL_CHECKPOINT_CHAR_LIMIT + 2)
    expect(summary.endsWith("...")).toBe(true)
  })

  test("an already-persisted oversized value is trimmed on the next read", async () => {
    const sessionID = "h15-existing"
    await createGoal(sessionID, "verbose agent", { maxAutoTurns: 0 })
    const raw = JSON.parse(await Bun.file(statePath()).text())
    raw.goals[sessionID].lastAssistantText = VERBOSE
    await Bun.write(statePath(), JSON.stringify(raw, null, 2))

    expect((await readState()).goals[sessionID].lastAssistantText.length).toBeLessThanOrEqual(GOAL_MAX_RETAINED_TEXT)
  })
})

describe("H31: goal text is truncated on code-point boundaries, not UTF-16 code units", () => {
  // Every truncation in the goal module has to agree with `withinCharacterLimit`, which counts code
  // points because that is the unit the tool schema states its limit in. `String.slice` counts UTF-16
  // code units instead, and an emoji is two of them, so a cut placed by unit index does two wrong
  // things at once: it keeps about HALF the characters the limit allows, and it can end mid-pair and
  // leave a LONE SURROGATE behind. The lone surrogate is not cosmetic - it is what
  // `lastAssistantText` retains, and every checkpoint summary and continuation baseline is derived
  // from that field, so the derived text stops matching the text it was derived from, and "did this
  // turn say anything new" is exactly the comparison stall detection turns on.
  //
  // Astral text is the input that triggers both halves: the code points of an emoji alternate
  // between the high and low surrogate at even and odd UNIT indices, so a unit-indexed cut lands on a
  // high surrogate for one of every two possible cut points.
  const ASTRAL = "\u{1f600}"

  test("the retained assistant text keeps the character budget, and is a well-formed prefix", async () => {
    const sessionID = "h31-retained"
    await createGoal(sessionID, "truncation", { maxAutoTurns: 0 })

    // An odd number of code units before the first emoji, so the unit-indexed cut at
    // GOAL_MAX_RETAINED_TEXT falls in the middle of a pair.
    const text = "a" + ASTRAL.repeat(GOAL_MAX_RETAINED_TEXT)
    await recordAssistantProgress(sessionID, { messageID: "m1", text })

    const retained = (await readState()).goals[sessionID].lastAssistantText
    expect([...retained].length).toBe(GOAL_MAX_RETAINED_TEXT)
    // A lone surrogate is not a character, it is half of one, and it renders as a replacement char.
    expect(retained.isWellFormed()).toBe(true)
    expect(text.startsWith(retained)).toBe(true)
  })

  test("a checkpoint summary cut mid-emoji stays well formed", async () => {
    const sessionID = "h31-checkpoint"
    await createGoal(sessionID, "truncation", { maxAutoTurns: 0 })

    // Over the character limit, so the summary is actually cut - and a unit-indexed cut at
    // GOAL_CHECKPOINT_CHAR_LIMIT - 1 lands on the high half of a pair for text like this.
    await recordAssistantProgress(sessionID, {
      messageID: "m1",
      text: ASTRAL.repeat(GOAL_CHECKPOINT_CHAR_LIMIT + 20),
    })

    const summary = (await getGoal(sessionID))?.lastCheckpoint?.summary ?? ""
    expect(summary).not.toBe("")
    expect(summary.isWellFormed()).toBe(true)
    // The character limit plus the truncation marker, matching the ASCII bound asserted above.
    expect([...summary].length).toBeLessThanOrEqual(GOAL_CHECKPOINT_CHAR_LIMIT + 2)
    expect(summary.endsWith("...")).toBe(true)
  })

  test("a history entry written from an astral objective stays well formed", async () => {
    // `updateGoalObjective` summarizes at its own 400-character limit, so this covers the
    // non-checkpoint path through `summarizeText` - and it is model-authored text, which is what
    // reaches the next turn's context through `get_goal_history`.
    const sessionID = "h31-history"
    await createGoal(sessionID, "truncation", { maxAutoTurns: 0 })

    await updateGoalObjective(sessionID, ASTRAL.repeat(500))

    const history = (await readState()).goals[sessionID].history
    const entry = history.find((item) => item.type === "updated")
    expect(entry).toBeDefined()
    expect(entry!.detail.isWellFormed()).toBe(true)
    // The one history limit, plus the truncation marker. Asserting against the nested 400 this used
    // to imply would have passed for a string that could never have been produced.
    expect([...entry!.detail].length).toBeLessThanOrEqual(GOAL_CHECKPOINT_CHAR_LIMIT + 2)
    expect(entry!.detail.endsWith("...")).toBe(true)
  })
})

describe("H17: the wall-clock cursor is normalized like the token cursor", () => {
  // `lastAccountedAt` is the one remaining field that participates in arithmetic without being
  // normalized, and it is the duration limit's counterpart to the token cursor: `accountWallClock`
  // adds `now - lastAccountedAt` to `timeUsedSeconds`, and `snapshot` projects the live delta from
  // it. A negative cursor is in the epoch, so it charged the whole epoch as elapsed time and the
  // goal was declared over its duration limit on the first accounting round.

  test("a negative wall-clock cursor does not instantly exhaust the duration limit", async () => {
    const sessionID = "h17-negative-clock"
    await createGoal(sessionID, "bounded time", { maxDurationSeconds: 3_600 })
    const raw = JSON.parse(await Bun.file(statePath()).text())
    raw.goals[sessionID].lastAccountedAt = -500
    await Bun.write(statePath(), JSON.stringify(raw, null, 2))

    await accountUsage(sessionID, 0)

    const goal = await getGoal(sessionID)
    expect(goal?.timeUsedSeconds).toBeLessThan(60)

    // And the consequence is gone: before the fix those ~56 years were past any duration limit, so
    // the goal could not be resumed at all - wedged by a single corrupt field.
    await setGoalStatus(sessionID, "paused")
    const resumed = await setGoalStatus(sessionID, "active")
    expect(resumed.status).toBe("active")
    expect(resumed.timeUsedSeconds).toBeLessThan(60)
  })

  test("a fractional wall-clock cursor cannot accrue a fraction of a second", async () => {
    // The elapsed-time counter is normalized to a non-negative integer on read, so a fractional
    // cursor makes it accrue a fraction, which the next read then snaps to 0 - forgetting the
    // elapsed time entirely, so a duration limit could never trip.
    const sessionID = "h17-fractional-clock"
    await createGoal(sessionID, "bounded time", { maxDurationSeconds: 3_600 })
    const raw = JSON.parse(await Bun.file(statePath()).text())
    // 30 seconds back, so the delta is a real 30.5 rather than a negative one the max() would eat.
    raw.goals[sessionID].lastAccountedAt = Math.floor(Date.now() / 1000) - 30.5
    await Bun.write(statePath(), JSON.stringify(raw, null, 2))

    await accountUsage(sessionID, 0)

    // 30 seconds genuinely elapsed. The fractional cursor accrued 30.5, which the non-negative
    // integer normalization on the next read snapped to 0 - forgetting the elapsed time entirely,
    // so a duration limit could never trip.
    const state = await readState()
    expect(state.goals[sessionID].timeUsedSeconds).toBeGreaterThanOrEqual(29)
    expect(Number.isInteger(state.goals[sessionID].lastAccountedAt)).toBe(true)
  })
})

describe("H18: the continuation throttle cursor is trusted like the other clocks", () => {
  // `reserveContinuation` throttles on `now - lastContinuationAt < minIntervalSeconds`. That
  // comparison is asymmetric: a cursor in the FUTURE yields a negative delta, which is below any
  // interval, so the goal is throttled until the wall clock catches up. A backwards clock step (NTP
  // correction, VM resume after suspend) leaves the cursor ahead of `now`, and `reactivate` does not
  // clear it, so a resume does not help either: the goal silently stops auto-continuing with no
  // error anywhere. `lastContinuationAt` was also the last arithmetic field normalizeGoal skipped.

  test("a continuation cursor in the future does not throttle the goal", async () => {
    const sessionID = "h18-future"
    await createGoal(sessionID, "keep going", { maxAutoTurns: 10 })
    const raw = JSON.parse(await Bun.file(statePath()).text())
    raw.goals[sessionID].lastContinuationAt = Math.floor(Date.now() / 1000) + 3_600
    await Bun.write(statePath(), JSON.stringify(raw, null, 2))

    // The interval is deliberately non-zero: whether a future cursor throttles must not depend on
    // the configured interval at all.
    const goal = await reserveContinuation(sessionID, 0, 3)
    expect(goal?.status).toBe("active")
    expect(goal?.autoTurns).toBe(1)
  })

  test("a continuation cursor in the past still throttles", async () => {
    // Control: the throttle itself must keep working, or the fix above would just disable it.
    const sessionID = "h18-past"
    await createGoal(sessionID, "keep going", { maxAutoTurns: 10 })
    const raw = JSON.parse(await Bun.file(statePath()).text())
    raw.goals[sessionID].lastContinuationAt = Math.floor(Date.now() / 1000)
    await Bun.write(statePath(), JSON.stringify(raw, null, 2))

    expect(await reserveContinuation(sessionID, 0, 3)).toBeNull()
    // ...and past the interval it is allowed through again.
    raw.goals[sessionID].lastContinuationAt = Math.floor(Date.now() / 1000) - 10
    await Bun.write(statePath(), JSON.stringify(raw, null, 2))
    expect((await reserveContinuation(sessionID, 0, 3))?.autoTurns).toBe(1)
  })
})

describe("H19: the plan-mode pause transition", () => {
  // `pauseGoalForPlanMode` is a real state transition the driver reaches on its own, and it had no
  // direct coverage at all. It is distinct from `setGoalStatus("paused")`: it records "plan mode" as
  // the stop reason rather than "paused", it is only reachable for an ACTIVE goal, and it is the
  // only path that sets the plan-mode blocker text.
  const PLAN_BLOCKER = "Goal execution is paused while the session is in Plan mode"

  test("it pauses an active goal, records why, and banks the elapsed time", async () => {
    const sessionID = "h19-plan"
    await createGoal(sessionID, "plan mode work", { maxAutoTurns: 10 })

    // Age the cursor so the elapsed time is observable.
    const raw = JSON.parse(await Bun.file(statePath()).text())
    raw.goals[sessionID].lastAccountedAt = Math.floor(Date.now() / 1000) - 10
    await Bun.write(statePath(), JSON.stringify(raw, null, 2))

    const goal = await pauseGoalForPlanMode(sessionID)
    expect(goal?.status).toBe("paused")
    expect(goal?.stopReason).toBe("plan mode")
    expect(goal?.blocker).toContain(PLAN_BLOCKER)
    // The time spent before the pause must be banked, not lost with the cursor.
    expect(goal?.timeUsedSeconds).toBeGreaterThanOrEqual(9)
    expect(goal?.history.at(-1)?.type).toBe("paused")

    // A paused goal accrues no further time.
    const after = await pauseGoalForPlanMode(sessionID)
    expect(after?.timeUsedSeconds).toBe(goal?.timeUsedSeconds)
  })

  test("a repeated plan-mode pause does not churn history", async () => {
    const sessionID = "h19-repeat"
    await createGoal(sessionID, "plan mode work", { maxAutoTurns: 10 })
    const first = await pauseGoalForPlanMode(sessionID)

    const second = await pauseGoalForPlanMode(sessionID)
    expect(second?.history.length).toBe(first?.history.length)
    expect(second?.stopReason).toBe("plan mode")
  })

  test("it never reopens a closed goal", async () => {
    const sessionID = "h19-closed"
    await createGoal(sessionID, "done", { maxAutoTurns: 10 })
    await completeGoal(sessionID, "shipped")

    const goal = await pauseGoalForPlanMode(sessionID)
    expect(goal?.status).toBe("complete")
    expect(goal?.stopReason).toBeNull()
    expect(goal?.completionEvidence).toBe("shipped")
  })

  test("an unknown session is reported as absent rather than created", async () => {
    expect(await pauseGoalForPlanMode("h19-nobody")).toBeNull()
  })

  test("resuming after a plan-mode pause clears the plan-mode stop reason", async () => {
    const sessionID = "h19-resume"
    await createGoal(sessionID, "plan mode work", { maxAutoTurns: 10 })
    await pauseGoalForPlanMode(sessionID)

    const resumed = await setGoalStatus(sessionID, "active")
    expect(resumed.status).toBe("active")
    expect(resumed.stopReason).toBeNull()
    expect(resumed.blocker).toBeNull()
    expect(resumed.history.at(-1)?.type).toBe("resumed")
  })
})

describe("H20: the prompt-agent record is a no-op when nothing changes", () => {
  // `recordPromptAgent` runs on every user chat message, so it is the most frequently called
  // bookkeeping path in the plugin, and it had no direct coverage. It must not rewrite history for
  // an unchanged agent, and it must never resurrect a closed goal.
  test("it records the agent once and then stays quiet", async () => {
    const sessionID = "h20-agent"
    await createGoal(sessionID, "track the agent", { maxAutoTurns: 10 })

    const first = await recordPromptAgent(sessionID, "build")
    expect(first?.lastPromptAgent).toBe("build")
    const history = first?.history.length

    // The same agent again must not churn history: this runs on every message.
    const second = await recordPromptAgent(sessionID, "build")
    expect(second?.lastPromptAgent).toBe("build")
    expect(second?.history.length).toBe(history)

    const changed = await recordPromptAgent(sessionID, "plan")
    expect(changed?.lastPromptAgent).toBe("plan")
  })

  test("it is a no-op for a closed goal and for an unknown session", async () => {
    const sessionID = "h20-closed"
    await createGoal(sessionID, "done", { maxAutoTurns: 10, agent: "build" })
    await completeGoal(sessionID, "shipped")

    const goal = await recordPromptAgent(sessionID, "plan")
    expect(goal?.status).toBe("complete")
    expect(goal?.lastPromptAgent).toBe("build")
    expect(await recordPromptAgent("h20-nobody", "build")).toBeNull()
  })

  test("a blank agent name is ignored rather than recorded", async () => {
    const sessionID = "h20-blank"
    await createGoal(sessionID, "track the agent", { maxAutoTurns: 10, agent: "build" })

    expect(await recordPromptAgent(sessionID, "   ")).toBeNull()
    expect((await getGoal(sessionID))?.lastPromptAgent).toBe("build")
    // ...and the surrounding whitespace of a real name is trimmed.
    expect((await recordPromptAgent(sessionID, "  plan  "))?.lastPromptAgent).toBe("plan")
  })
})
