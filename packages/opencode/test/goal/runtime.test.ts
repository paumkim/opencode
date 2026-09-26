import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGoal, getGoal, statePath } from "@/goal/impl"
import goalPlugin, { staleAllContinuationClaims } from "@/plugin/goal/server"

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
  promptAsync?: () => unknown
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
  return goalPlugin.server({ client: client(overrides) } as never, options as never)
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
