import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGoal, getGoal, readState } from "@/goal/impl"
import { createGoalRuntime } from "@/goal/driver"

let stateDir: string | undefined
const previous = process.env.OPENCODE_GOAL_STATE_PATH

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "opencode-goal-compaction-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(stateDir, "goals.json")
})

afterEach(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true })
  stateDir = undefined
  if (previous === undefined) delete process.env.OPENCODE_GOAL_STATE_PATH
  else process.env.OPENCODE_GOAL_STATE_PATH = previous
})

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

async function transformHooks() {
  return createGoalRuntime({ client: client() as never }).hooks
}

/** One assistant message whose provider accounting reports exactly `total` tokens. */
function assistant(sessionID: string, total: number, extra: Record<string, unknown> = {}) {
  return {
    info: { role: "assistant", sessionID, ...extra },
    parts: [{ type: "step-finish", tokens: { total } }],
  }
}

const transform = async (hooks: Awaited<ReturnType<typeof transformHooks>>, input: unknown, messages: unknown[]) => {
  const output = { messages }
  await hooks["experimental.chat.messages.transform"]?.(input as never, output as never)
  return output
}

describe("compaction must not charge the goal for the prefix it summarizes", () => {
  test("a compaction transform does not rewind the usage cursor", async () => {
    const sessionID = "compaction-cursor"
    await createGoal(sessionID, "keep going", { tokenBudget: 10_000_000 })
    const hooks = await transformHooks()

    // Ordinary LLM steps: the hook receives the FULL history. The first observation only anchors
    // the cursor, so warm up first and measure the step after that.
    await transform(hooks, {}, [assistant(sessionID, 90_000)])
    await transform(hooks, {}, [assistant(sessionID, 100_000)])
    const afterFirst = await readState()
    expect(afterFirst.goals[sessionID].tokensUsed).toBe(10_000)
    expect(afterFirst.goals[sessionID].lastSessionTokens).toBe(100_000)

    // 2. Compaction runs. `SessionCompaction.process` hands the hook the compacted-away PREFIX,
    //    which is a strict subset of what step 1 saw and carries NO compaction marker of its own:
    //    prior compaction summaries are filtered out of the prefix before the hook fires.
    await transform(hooks, { sessionID, compaction: true }, [assistant(sessionID, 10_000)])
    const afterCompaction = await readState()
    expect(afterCompaction.goals[sessionID].lastSessionTokens).toBe(100_000)

    // 3. The next ordinary step sees the full history again. With the cursor intact this charges
    //    only the new growth; with the cursor rewound it charges the whole retained context again.
    await transform(hooks, {}, [assistant(sessionID, 100_000)])
    const goal = await getGoal(sessionID)
    expect(goal?.tokensUsed).toBe(10_000)
  })

  test("a compaction transform is not charged at all, not merely clamped", async () => {
    // The guard must be a total short-circuit. A "charge but never rewind" fix would still bill the
    // goal for a summarizer request it did not ask for, and would show up as a budget goal
    // reporting spend that no provider ever charged it for.
    const sessionID = "compaction-unmarked"
    await createGoal(sessionID, "keep going", { tokenBudget: 10_000_000 })
    const hooks = await transformHooks()

    await transform(hooks, {}, [assistant(sessionID, 90_000)])
    expect((await readState()).goals[sessionID].lastSessionTokens).toBe(90_000)

    // A large prefix that carries no compaction marker of its own - the real call site's shape.
    await transform(hooks, { sessionID, compaction: true }, [assistant(sessionID, 80_000)])

    const state = await readState()
    expect(state.goals[sessionID].lastSessionTokens).toBe(90_000)
    expect(state.goals[sessionID].tokensUsed).toBe(0)
  })

  test("an empty compaction prefix is still recognised", async () => {
    // `history.filter(...)` in compaction.ts can leave the prefix empty, so the guard cannot depend
    // on finding anything in the array.
    const sessionID = "compaction-empty"
    await createGoal(sessionID, "keep going", { tokenBudget: 10_000_000 })
    const hooks = await transformHooks()

    await transform(hooks, { sessionID, compaction: true }, [])
    const state = await readState()
    expect(state.goals[sessionID]).toBeDefined()
    expect(state.goals[sessionID].lastSessionTokens).toBeUndefined()
  })
})
