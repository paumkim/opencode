import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGoal, getGoal, markGoalUnmet, setGoalStatus, statePath, completeGoal } from "@/goal/impl"
import { createGoalRuntime, staleAllContinuationClaims } from "@/goal/driver"

let stateDir: string | undefined
const previous = process.env.OPENCODE_GOAL_STATE_PATH

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "opencode-goal-runtime-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(stateDir, "goals.json")
})

afterEach(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true })
  stateDir = undefined
  if (previous === undefined) delete process.env.OPENCODE_GOAL_STATE_PATH
  else process.env.OPENCODE_GOAL_STATE_PATH = previous
})

type ClientOverrides = {
  promptAsync?: (input?: { body?: Record<string, unknown> }) => unknown
  children?: () => unknown
  status?: () => unknown
  messages?: () => unknown
  get?: () => unknown
}

function client(overrides: ClientOverrides = {}) {
  return {
    session: {
      get: overrides.get ?? (() => ({ data: { id: "s" } })),
      messages: overrides.messages ?? (() => ({ data: [] })),
      children: overrides.children ?? (() => ({ data: [] })),
      status: overrides.status ?? (() => ({ data: {} })),
      promptAsync: overrides.promptAsync ?? (() => ({ data: undefined })),
    },
    app: { log: () => ({ data: {} }) },
  }
}

async function hooks(overrides: ClientOverrides = {}, options: Record<string, unknown> = {}) {
  return createGoalRuntime({ client: client(overrides) as never, options: options as never }).hooks
}

const idleEvent = (sessionID: string) => ({ type: "session.idle", properties: { sessionID } })

describe("C3: a rejected continuation is recorded as a failure, not a success", () => {
  test("an HTTP error tuple from promptAsync is not treated as a delivered turn", async () => {
    const sessionID = "c3-rejected"
    await createGoal(sessionID, "keep going", { maxAutoTurns: 100 })

    const h = await hooks({
      promptAsync: () => ({ error: { message: "session not found" }, response: { status: 404 } }),
    })

    // Fire the idle event that drives auto-continue, then let it settle.
    await h.event?.({ event: idleEvent(sessionID) } as never)

    const goal = await getGoal(sessionID)
    // Before the fix the result tuple was discarded, so a rejected dispatch was recorded as a
    // SUCCESS: continuationFailures stayed 0 and lastStatus claimed the prompt was sent.
    expect(goal?.continuationFailures).toBe(1)
    expect(goal?.lastStatus).toContain("failed")
    expect(goal?.awaitingContinuationProgress).toBe(false)
  })

  test("a rejected dispatch is recorded in history as an error", async () => {
    const sessionID = "c3-history"
    await createGoal(sessionID, "keep going", { maxAutoTurns: 100 })
    const h = await hooks({
      promptAsync: () => ({ error: { message: "session not found" }, response: { status: 404 } }),
    })
    await h.event?.({ event: idleEvent(sessionID) } as never)
    const goal = await getGoal(sessionID)
    expect(goal?.history.some((entry) => entry.type === "error")).toBe(true)
    // The goal stays active until the breaker threshold, which is the correct behaviour.
    expect(goal?.status).toBe("active")
    expect(goal?.continuationFailures).toBe(1)
  })

  test("a successful promptAsync records success and stays active", async () => {
    const sessionID = "c3-ok"
    await createGoal(sessionID, "keep going", { maxAutoTurns: 100 })
    const h = await hooks()
    await h.event?.({ event: idleEvent(sessionID) } as never)
    const goal = await getGoal(sessionID)
    expect(goal?.continuationFailures).toBe(0)
    expect(goal?.status).toBe("active")
  })
})

describe("H5: a children error must not be read as zero children", () => {
  const runningTaskOutput = "task_id: task_1\nstate: running\n"

  test("an HTTP error from session.children does not force-clear a running task", async () => {
    const sessionID = "h5-children"
    await createGoal(sessionID, "defer while tasks run", { maxAutoTurns: 100 })

    // One plugin instance (and therefore ONE TaskTracker) whose children() behavior we can flip.
    let childrenFails = false
    let promptCalls = 0
    const h = await hooks({
      children: () => (childrenFails ? { error: { message: "boom" }, response: { status: 500 } } : { data: [{ id: "child-1" }] }),
      status: () => ({ data: { "child-1": { type: "busy" } } }),
      promptAsync: () => {
        promptCalls += 1
        return { data: undefined }
      },
    })

    // Register a genuinely running child task through the real tool hooks.
    await h["tool.execute.before"]?.({ tool: "task", sessionID, callID: "call-1" } as never, {} as never)
    await h["tool.execute.after"]?.(
      { tool: "task", sessionID, callID: "call-1" } as never,
      { output: runningTaskOutput } as never,
    )

    // Baseline: with a healthy children() the running task blocks auto-continue.
    await h.event?.({ event: idleEvent(sessionID) } as never)
    expect(promptCalls).toBe(0)
    const baseline = await getGoal(sessionID)
    expect(baseline?.autoTurns).toBe(0)

    // Now the children endpoint errors while the task is still running. Treating that as
    // "no children" calls markAbsentRunningChildren with an empty set, which marks the running
    // task snapshot-idle and DELETES it once the 250ms hold expires. Auto-continue must still be
    // blocked; only a real terminal observation may release the task.
    childrenFails = true
    // First drive, then wait past the snapshot-idle hold so the deletion would have happened.
    await h.event?.({ event: idleEvent(sessionID) } as never)
    await new Promise((resolve) => setTimeout(resolve, 400))
    await h.event?.({ event: idleEvent(sessionID) } as never)

    const goal = await getGoal(sessionID)
    // The live task must STILL block auto-continue: no continuation was dispatched.
    expect(promptCalls).toBe(0)
    expect(goal?.autoTurns).toBe(0)
    expect(goal?.status).toBe("active")
    expect(goal?.continuationFailures).toBe(0)
  })

  test("a children error is not a failure of the continuation itself", async () => {
    const sessionID = "h5-nocharge"
    await createGoal(sessionID, "no spurious charge", { maxAutoTurns: 100 })
    const failing = await hooks({
      children: () => ({ error: { message: "boom" }, response: { status: 500 } }),
      promptAsync: () => ({ data: undefined }),
    })
    await failing.event?.({ event: idleEvent(sessionID) } as never)
    // A transient observation error is not a failed continuation, so it must not be charged
    // against the failure breaker (which would eventually pause a perfectly healthy goal).
    expect((await getGoal(sessionID))?.continuationFailures).toBe(0)
  })
})

describe("H6: a continuation claim cannot be held forever", () => {
  test("a hung continuation is eventually reclaimed by the claim TTL", async () => {
    const sessionID = "h6-hang"
    await createGoal(sessionID, "wedge test", { maxAutoTurns: 100 })

    // promptAsync never settles, standing in for a hung HTTP call (the SDK disables request
    // timeouts globally, so a real hang never rejects either).
    const h = await hooks({ promptAsync: () => new Promise(() => {}) }, { min_continue_interval_seconds: 1 })

    // Fire the idle event that starts a continuation. It will hang while holding the claim.
    void h.event?.({ event: idleEvent(sessionID) } as never)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await getGoal(sessionID))?.autoTurns).toBe(1)

    // Simulate the claim being older than the TTL (a genuinely hung call would look like this
    // minutes later) and wait past the continuation throttle. With TTL-based eviction the next
    // drive can claim the session again; without eviction the session is silently dead for the
    // rest of the process and the goal shows "active" while doing nothing.
    staleAllContinuationClaims()
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    void h.event?.({ event: idleEvent(sessionID) } as never)
    await new Promise((resolve) => setTimeout(resolve, 100))
    // The reclaimed run reserved another continuation, proving the session was not wedged.
    expect((await getGoal(sessionID))?.autoTurns).toBe(2)
  })
})

describe("H4: a deferral for a running task is never dropped", () => {
  test("a blocked auto-continue still resumes once the task finishes", async () => {
    const sessionID = "h4-defer"
    await createGoal(sessionID, "deferred", { maxAutoTurns: 100 })

    let promptCalls = 0
    let childRunning = true
    // The child session id equals the task id, and once the task finishes it no longer appears as
    // a child. A plain running task (not a snapshot-idle hold) yields retryAt === null, so the
    // deferral must still schedule a bounded poll; otherwise the only re-entry is the CHILD
    // session's idle event, which resolves to a different sessionID and silently no-ops.
    const h = await hooks(
      {
        children: () => (childRunning ? { data: [{ id: "task_1" }] } : { data: [] }),
        status: () => ({ data: childRunning ? { task_1: { type: "busy" } } : {} }),
        promptAsync: () => {
          promptCalls += 1
          return { data: undefined }
        },
      },
      { min_continue_interval_seconds: 1 },
    )

    // Register a running child task through the real tool hooks.
    await h["tool.execute.before"]?.({ tool: "task", sessionID, callID: "c1" } as never, {} as never)
    await h["tool.execute.after"]?.(
      { tool: "task", sessionID, callID: "c1" } as never,
      { output: "task_id: task_1\nstate: running\n" } as never,
    )

    // The running task must block the continuation.
    await h.event?.({ event: idleEvent(sessionID) } as never)
    expect(promptCalls).toBe(0)
    expect((await getGoal(sessionID))?.autoTurns).toBe(0)

    // The task finishes. A terminal task stays blocking until a NEW assistant message reconciles
    // it, which is how the tracker avoids clearing a task whose result the parent has not seen.
    childRunning = false
    await h["tool.execute.after"]?.(
      { tool: "task", sessionID, callID: "c2" } as never,
      { output: "task_id: task_1\nstate: completed\n" } as never,
    )
    await h.event?.({
      event: {
        type: "message.updated",
        properties: {
          sessionID,
          info: { id: "assistant-2", role: "assistant", sessionID, time: { completed: Date.now() } },
        },
      },
    } as never)

    // No further idle event is fired here on purpose: the only thing that can revive this session
    // is the retry the deferral scheduled. Waiting past the continuation throttle is enough.
    await new Promise((resolve) => setTimeout(resolve, 1_300))
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(promptCalls).toBeGreaterThan(0)
    expect((await getGoal(sessionID))?.autoTurns).toBeGreaterThan(0)
    await h.dispose?.()
  })
})

describe("H7: goal bookkeeping never fails a prompt", () => {
  test("an unwritable state file does not reject the transform hooks", async () => {
    const sessionID = "h7-isolation"
    await createGoal(sessionID, "resilient", { maxAutoTurns: 100 })

    // Point the state file at a path that cannot be created (a file where a dir must be).
    process.env.OPENCODE_GOAL_STATE_PATH = join(stateDir!, "blocked", "nested", "goals.json")
    await Bun.write(join(stateDir!, "blocked"), "not a directory")

    const h = await hooks()
    // These run inside the LLM step loop. None may reject.
    await expect(
      h["experimental.chat.messages.transform"]?.({ sessionID } as never, {
        messages: [],
      } as never),
    ).resolves.toBeUndefined()
    await expect(
      h["experimental.chat.system.transform"]?.({ sessionID } as never, { system: ["base"] } as never),
    ).resolves.toBeUndefined()
    await expect(h.event?.({ event: idleEvent(sessionID) } as never)).resolves.toBeUndefined()
  })
})

describe("H9: the compaction summarizer is not given goal continuation instructions", () => {
  test("a compaction-shaped request receives no goal reminder", async () => {
    const sessionID = "h9-compaction"
    await createGoal(sessionID, "long task", { maxAutoTurns: 100 })
    const h = await hooks()

    const output = { system: ["You are a compacting agent. Summarize the conversation so far."] }
    await h["experimental.chat.system.transform"]?.({ sessionID } as never, output as never)
    const joined = output.system.join("\n")
    expect(joined).not.toContain("OpenCode goal mode")
  })

  test("a normal request still receives the goal reminder", async () => {
    const sessionID = "h9-normal"
    await createGoal(sessionID, "long task", { maxAutoTurns: 100 })
    const h = await hooks()
    const output = { system: ["You are opencode, an interactive CLI agent."] }
    await h["experimental.chat.system.transform"]?.({ sessionID } as never, output as never)
    expect(output.system.join("\n")).toContain("OpenCode goal mode")
  })
})

describe("H22: a closed goal stops reminding the model to keep working", () => {
  // `systemReminder` is the only thing standing between a finished goal and an infinite
  // "Continue working toward the active session goal" injection, and this is the one branch of it
  // that no test covered: a completed or unmet goal must contribute nothing at all. A regression
  // here is not a cosmetic extra system block - the continuation prompt is what drives the
  // auto-continue loop, so a closed goal that still got one would be resumed indefinitely.
  for (const status of ["complete", "unmet"] as const) {
    test(`an ${status} goal injects no reminder and leaves the system prompt untouched`, async () => {
      const sessionID = `h22-${status}`
      await createGoal(sessionID, "finish this and stop", { maxAutoTurns: 100 })
      const h = await hooks()
      const base = "You are opencode, an interactive CLI agent."

      // Control: while active the reminder IS merged, so a silent pass below is the status
      // closing the goal and not the hook never running.
      const active = { system: [base] }
      await h["experimental.chat.system.transform"]?.({ sessionID } as never, active as never)
      expect(active.system.join("\n")).toContain("OpenCode goal mode")

      if (status === "complete") await completeGoal(sessionID, "verified in the worktree")
      else await markGoalUnmet(sessionID, "the upstream API does not exist")

      const closed = { system: [base] }
      await h["experimental.chat.system.transform"]?.({ sessionID } as never, closed as never)
      // Exactly the original system prompt: not an empty block appended, not a partial reminder.
      expect(closed.system).toEqual([base])
    })
  }

  test("a paused goal still reports its state instead of a continuation prompt", async () => {
    // A paused goal must not be told to continue, but unlike a closed one it still has state
    // worth surfacing, and losing that would leave the user with no way to see why it stopped.
    const sessionID = "h22-paused"
    await createGoal(sessionID, "paused work", { maxAutoTurns: 100 })
    const h = await hooks()
    await setGoalStatus(sessionID, "paused")

    const output = { system: ["You are opencode, an interactive CLI agent."] }
    await h["experimental.chat.system.transform"]?.({ sessionID } as never, output as never)
    const joined = output.system.join("\n")
    expect(joined).toContain("OpenCode goal mode")
    expect(joined).not.toContain("Continue working toward the active session goal")
  })
})

describe("H8: configured plugin options are applied", () => {
  test("max_auto_turns from plugin options is enforced", async () => {
    const sessionID = "h8-opts"
    await createGoal(sessionID, "bounded by config", { maxAutoTurns: null })
    const h = await hooks({ promptAsync: () => ({ data: undefined }) }, { max_auto_turns: 1 })

    await h.event?.({ event: idleEvent(sessionID) } as never)
    expect((await getGoal(sessionID))?.autoTurns).toBe(1)
    await h.event?.({ event: idleEvent(sessionID) } as never)
    // second continuation must hit the configured cap of 1
    expect((await getGoal(sessionID))?.status).toBe("usageLimited")
  })

  test("auto_continue=false disables auto-continuation entirely", async () => {
    const sessionID = "h8-off"
    await createGoal(sessionID, "no auto continue", { maxAutoTurns: 100 })
    const h = await hooks({ promptAsync: () => ({ data: undefined }) }, { auto_continue: false })
    await h.event?.({ event: idleEvent(sessionID) } as never)
    expect((await getGoal(sessionID))?.autoTurns).toBe(0)
  })
})

describe("H23: deleting a session releases the tool-call credit it left behind", () => {
  // `TaskTracker` keeps five session-keyed maps. `observeSessionDeleted` released three of them
  // (`tasks`, `latestAssistantBySession`, the snapshot-idle holds) but not `toolCallsBySession` or
  // `pendingTaskCalls`, so a deleted session's bookkeeping outlived it for the life of the process -
  // the exact leak the session processor fixed with an explicit `forgetSession` for the same reason.
  //
  // This got worse when tool-call accounting was fixed to be consumed only by the scoring call:
  // before that, `message.updated` and the messages-transform hook also drained the map, and after
  // it they deliberately do not. A deleted session is precisely the case where nothing ever drains
  // it again.
  //
  // The cost is not only memory. A stale count is read as PROGRESS: `recordAssistantProgress`
  // scores any turn with `toolCalls > 0` as work done, so a session ID that is deleted and then
  // reused silently has its first stall check waived by a tool call from the previous life.
  test("a tool call made before deletion does not credit a later turn in the same session ID", async () => {
    const sessionID = "h23-stale"
    await createGoal(sessionID, "work that will stall", { maxAutoTurns: 0 })

    let latest: { data: unknown[] } = { data: [] }
    const h = await hooks(
      { messages: () => latest, promptAsync: () => ({ data: undefined }) },
      // One low-progress turn is enough to pause, so the assertion below is unambiguous.
      { min_continue_interval_seconds: 1, max_no_progress_turns: 1 },
    )

    // A turn runs a tool. Nothing scores it, so the count stays parked in `toolCallsBySession`.
    await h.event?.({ event: idleEvent(sessionID) } as never)
    await h["tool.execute.before"]?.({ tool: "edit", sessionID, callID: "c-before-delete" } as never, {} as never)

    // The session goes away.
    await h.event?.({ event: { type: "session.deleted", properties: { sessionID } } } as never)

    // The same session ID comes back and the next turn is genuinely silent: no tools, no prose.
    latest = { data: [{ info: { id: "turn-after", role: "assistant", sessionID, tokens: { output: 40 } }, parts: [] }] }
    await h.event?.({ event: idleEvent(sessionID) } as never)
    await h.event?.({
      event: {
        type: "message.updated",
        properties: { sessionID, info: { id: "turn-after", role: "assistant", sessionID, time: { completed: Date.now() } } },
      },
    } as never)

    // The stale credit made `workedWithTools` true, so the stall was never recorded.
    const goal = await getGoal(sessionID)
    expect(goal?.stopReason).toBe("no progress")
    expect(goal?.status).toBe("paused")
  })
})

describe("H12: tool activity reaches the turn that is actually scored", () => {
  // An unattended agent doing a refactor or an investigation narrates almost nothing: each turn is
  // nothing but tool calls. Scoring on prose alone paused it after two turns, calling real work a
  // stall - so `recordAssistantProgress` treats a turn with tool calls as progress. That only
  // works if the tool-call count survives until the scoring call.
  //
  // It did not. `TaskTracker.takeToolCalls` reads AND deletes, and three call sites consume it:
  // `runAutoContinue` (the only one that actually scores) plus `message.updated` and
  // `experimental.chat.messages.transform` (neither of which scores). Both of the latter fire
  // while the turn is still running, so the count was always gone by the time the turn was judged
  // and the "tool-only turn counts as progress" rule was dead in production.
  test("a turn that only ran tools is not scored as a stall", async () => {
    const sessionID = "h12-tools"
    await createGoal(sessionID, "long refactor", { maxAutoTurns: 0 })

    let latest: { data: unknown[] } = { data: [] }
    const h = await hooks(
      {
        messages: () => latest,
        promptAsync: () => ({ data: undefined }),
      },
      { min_continue_interval_seconds: 1 },
    )

    for (const id of ["turn-a", "turn-b", "turn-c"]) {
      // A continuation is dispatched and the model starts working.
      await h.event?.({ event: idleEvent(sessionID) } as never)
      // It runs a tool and narrates nothing.
      await h["tool.execute.before"]?.({ tool: "edit", sessionID, callID: `c-${id}` } as never, {} as never)
      latest = {
        data: [{ info: { id, role: "assistant", sessionID, tokens: { output: 40 } }, parts: [] }],
      }
      await h.event?.({
        event: {
          type: "message.updated",
          properties: {
            sessionID,
            info: { id, role: "assistant", sessionID, time: { completed: Date.now() } },
          },
        },
      } as never)
      // Past the continuation throttle, so the next dispatch is not refused.
      await new Promise((resolve) => setTimeout(resolve, 1_100))
    }

    const goal = await getGoal(sessionID)
    // Three silent-but-working turns must not read as a stall.
    expect(goal?.noProgressTurns).toBe(0)
    expect(goal?.status).toBe("active")
    expect(goal?.stopReason).toBeNull()
  })

  test("a turn with no tools and no text is still a stall", async () => {
    // Control: the counter is not simply being ignored. A genuinely silent turn must still count.
    const sessionID = "h12-silent"
    await createGoal(sessionID, "stalled out", { maxAutoTurns: 0 })

    let latest: { data: unknown[] } = { data: [] }
    const h = await hooks(
      {
        messages: () => latest,
        promptAsync: () => ({ data: undefined }),
      },
      { min_continue_interval_seconds: 1 },
    )

    for (const id of ["turn-a", "turn-b", "turn-c"]) {
      await h.event?.({ event: idleEvent(sessionID) } as never)
      latest = {
        data: [{ info: { id, role: "assistant", sessionID, tokens: { output: 40 } }, parts: [] }],
      }
      await h.event?.({
        event: {
          type: "message.updated",
          properties: {
            sessionID,
            info: { id, role: "assistant", sessionID, time: { completed: Date.now() } },
          },
        },
      } as never)
      await new Promise((resolve) => setTimeout(resolve, 1_100))
    }

    const goal = await getGoal(sessionID)
    expect(goal?.status).toBe("paused")
    expect(goal?.stopReason).toBe("no progress")
  })
})

describe("H16: a continuation inherits the session's model variant on every path", () => {
  // A continuation must run on the same model, with the same variant, as the session it continues.
  // `prompt.ts` already resolves that shape correctly (`current.model.variant` unless it is
  // "default"). The driver has its own copy of that lookup for the continuation, and the copy
  // dropped the variant on its fallback path - the message-based lookup used when `session.get`
  // fails. The `void variant` in that function shows the omission was noticed and silenced rather
  // than fixed, so an unattended continuation after a transient `session.get` failure silently ran
  // the same model with different parameters.
  const promptBodies: Record<string, unknown>[] = []

  const capture = (overrides: ClientOverrides) => {
    promptBodies.length = 0
    return hooks({
      ...overrides,
      promptAsync: (input) => {
        promptBodies.push((input?.body ?? {}) as Record<string, unknown>)
        return { data: undefined }
      },
    })
  }

  const userMessageModel = (variant: string) => ({
    data: [{ info: { role: "user", model: { id: "test-model", providerID: "test", variant } } }],
  })

  test("the session-get path already carries the variant", async () => {
    const sessionID = "h16-primary"
    await createGoal(sessionID, "inherit model", { maxAutoTurns: 10 })
    const h = await capture({
      get: () => ({ data: { info: { model: { id: "test-model", providerID: "test", variant: "high" } } } }),
    })

    await h.event?.({ event: idleEvent(sessionID) } as never)
    expect(promptBodies.at(-1)?.model).toMatchObject({ providerID: "test", modelID: "test-model" })
    expect(promptBodies.at(-1)?.variant).toBe("high")
  })

  test("the message-lookup fallback carries the variant too", async () => {
    const sessionID = "h16-fallback"
    await createGoal(sessionID, "inherit model", { maxAutoTurns: 10 })
    const h = await capture({
      // A transient failure here is what pushes resolution onto the message-based fallback.
      get: () => {
        throw new Error("session lookup failed")
      },
      messages: () => userMessageModel("high"),
    })

    await h.event?.({ event: idleEvent(sessionID) } as never)
    expect(promptBodies.at(-1)?.model).toMatchObject({ providerID: "test", modelID: "test-model" })
    expect(promptBodies.at(-1)?.variant).toBe("high")
  })

  test("the default variant is not sent, matching the session-get path", async () => {
    // "default" means "no variant chosen". Sending it would pin the model to a variant the session
    // is not using, so both paths must drop it.
    const sessionID = "h16-default"
    await createGoal(sessionID, "inherit model", { maxAutoTurns: 10 })
    const h = await capture({
      get: () => {
        throw new Error("session lookup failed")
      },
      messages: () => userMessageModel("default"),
    })

    await h.event?.({ event: idleEvent(sessionID) } as never)
    expect(promptBodies.at(-1)?.model).toMatchObject({ providerID: "test", modelID: "test-model" })
    expect(promptBodies.at(-1)?.variant).toBeUndefined()
  })
})

describe("H21: a compaction transform must not move the token cursor", () => {
  // `accountUsage` differences each observation against `lastSessionTokens`, so the cursor must
  // track a monotonically growing total. The compaction transform receives only the compacted-away
  // PREFIX, whose total is SMALLER than the cursor. Charging it leaves the delta at zero but still
  // rewinds the cursor, and the next full transform then charges the entire retained context as
  // fresh usage - on every compaction. The guard for this existed, but sat after the charging call
  // instead of before it, so it protected only the assistant-progress call below it.
  const sessionID = "h21-compaction"

  const fullHistory = (total: number) => [
    { info: { role: "user", sessionID }, parts: [] },
    { info: { role: "assistant", sessionID }, parts: [{ type: "step-finish", tokens: { total } }] },
  ]

  const transform = async (messages: unknown[]) => {
    const h = await hooks()
    await h["experimental.chat.messages.transform"]?.({ sessionID } as never, { messages } as never)
  }

  test("compacting does not charge the retained context as new usage", async () => {
    await createGoal(sessionID, "bounded work", { tokenBudget: 1_000_000, sessionTokensAtCreation: 50_000 })

    await transform(fullHistory(50_000))
    expect((await getGoal(sessionID))?.tokensUsed).toBe(0)

    // Compaction: the hook sees only the prefix, so its total is far below the cursor.
    await transform([
      {
        info: { role: "assistant", sessionID, summary: true },
        parts: [{ type: "step-finish", tokens: { total: 12_000 } }],
      },
    ])

    // The next real step sees the full history again, now smaller because compaction removed
    // content. No new tokens were spent, so nothing may be charged.
    await transform(fullHistory(45_000))

    const goal = await getGoal(sessionID)
    expect(goal?.tokensUsed).toBe(0)
    expect(goal?.status).toBe("active")
  })

  test("genuine growth after a compaction is still charged", async () => {
    // Control: the assertion above must not pass merely because nothing is ever charged.
    await createGoal("h21-control", "bounded work", { tokenBudget: 1_000_000, sessionTokensAtCreation: 50_000 })
    const h = await hooks()
    const send = (messages: unknown[]) =>
      h["experimental.chat.messages.transform"]?.({ sessionID: "h21-control" } as never, { messages } as never)

    await send(
      fullHistory(50_000).map((message) => ({ ...message, info: { ...message.info, sessionID: "h21-control" } })),
    )
    await send([
      {
        info: { role: "assistant", sessionID: "h21-control", summary: true },
        parts: [{ type: "step-finish", tokens: { total: 12_000 } }],
      },
    ])
    // The session then really does spend more than the pre-compaction cursor: 2,000 fresh tokens.
    await send([
      { info: { role: "user", sessionID: "h21-control" }, parts: [] },
      {
        info: { role: "assistant", sessionID: "h21-control" },
        parts: [{ type: "step-finish", tokens: { total: 52_000 } }],
      },
    ])

    expect((await getGoal("h21-control"))?.tokensUsed).toBe(2_000)
  })
})
