import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGoal, getGoal, setGoalStatus, statePath } from "@/goal/impl"
import { createGoalRuntime } from "@/goal/driver"

let stateDir: string | undefined
const previous = process.env.OPENCODE_GOAL_STATE_PATH

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "opencode-goal-stall-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(stateDir, "goals.json")
})

afterEach(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true })
  stateDir = undefined
  if (previous === undefined) delete process.env.OPENCODE_GOAL_STATE_PATH
  else process.env.OPENCODE_GOAL_STATE_PATH = previous
})

/**
 * The reported failure: both unattended goals sat `active` with `autoTurns: 0` and no idle event
 * ever arrived, because their turn ABORTED. Continuation is gated on `session.idle`, so nothing
 * re-armed them and an unattended run idled indefinitely while looking healthy from the outside.
 */
function client() {
  return {
    session: {
      get: () => ({ data: { id: "s" } }),
      messages: () => ({ data: [] }),
      children: () => ({ data: [] }),
      status: () => ({ data: {} }),
      promptAsync: () => ({ data: undefined }),
    },
    app: { log: () => ({ data: {} }) },
  }
}

function runtime(options: Record<string, unknown> = {}) {
  return createGoalRuntime({
    client: client() as never,
    options: { auto_continue: true, max_stall_before_continue: 60, ...options } as never,
  })
}

async function backdate(sessionID: string, seconds: number) {
  const raw = JSON.parse(await Bun.file(statePath()).text())
  raw.goals[sessionID].updatedAt = Math.floor(Date.now() / 1000) - seconds
  await Bun.write(statePath(), JSON.stringify(raw, null, 2))
}

describe("the stall sweep re-arms a goal whose turn ended without an idle event", () => {
  test("an active goal quiet past the threshold is continued", async () => {
    const sessionID = "stall-1"
    await createGoal(sessionID, "keep going", { maxAutoTurns: 100 })
    await backdate(sessionID, 600)

    const rt = runtime()
    await rt.sweepStalledGoals()

    // Before the fix nothing could re-arm this: the continuation path is gated on an idle event
    // that an aborted turn never publishes, so autoTurns stayed 0 forever.
    expect((await getGoal(sessionID))?.autoTurns).toBe(1)
    await rt.dispose()
  })

  test("a goal that is still fresh is left alone", async () => {
    const sessionID = "stall-2"
    await createGoal(sessionID, "keep going", { maxAutoTurns: 100 })

    const rt = runtime()
    await rt.sweepStalledGoals()

    // The threshold is a floor, not a licence to nudge a healthy goal: a goal mid-flight has a
    // recent updatedAt and must not be raced by the sweep.
    expect((await getGoal(sessionID))?.autoTurns).toBe(0)
    await rt.dispose()
  })

  test("a paused goal is never re-armed", async () => {
    const sessionID = "stall-3"
    await createGoal(sessionID, "keep going", { maxAutoTurns: 100 })
    await setGoalStatus(sessionID, "paused")
    await backdate(sessionID, 600)

    const rt = runtime()
    await rt.sweepStalledGoals()

    expect((await getGoal(sessionID))?.autoTurns).toBe(0)
    await rt.dispose()
  })

  test("with no threshold configured the sweep does nothing", async () => {
    const sessionID = "stall-4"
    await createGoal(sessionID, "keep going", { maxAutoTurns: 100 })
    await backdate(sessionID, 600)

    // Opt-in, like every other goal limit: a deployment that never asked for stall recovery must
    // not get a timer it did not ask for.
    const rt = createGoalRuntime({ client: client() as never, options: { auto_continue: true } as never })
    await rt.sweepStalledGoals()

    expect((await getGoal(sessionID))?.autoTurns).toBe(0)
    await rt.dispose()
  })

  test("a duration string threshold is honoured, not silently ignored", async () => {
    const sessionID = "stall-5"
    await createGoal(sessionID, "keep going", { maxAutoTurns: 100 })
    await backdate(sessionID, 600)

    // The config schema declares these options as strings, and a string used to reach a
    // number-only parser and disable the timer with no error - so a configured `max_turn_time`
    // did nothing at all.
    const rt = runtime({ max_stall_before_continue: "5m" })
    await rt.sweepStalledGoals()

    expect((await getGoal(sessionID))?.autoTurns).toBe(1)
    await rt.dispose()
  })
})
