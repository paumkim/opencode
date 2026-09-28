import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Schedule } from "effect"
import { eq, inArray } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { Config } from "@opencode-ai/core/config"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { Database } from "@opencode-ai/core/database/database"
import { FanoutDelivery } from "@opencode-ai/core/fanout/delivery"
import { FanoutLedger } from "@opencode-ai/core/fanout/ledger"
import { FanoutGroupTable, FanoutWorkerTable } from "@opencode-ai/core/fanout/sql"
import { FanoutTool } from "@opencode-ai/core/tool/fanout"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventTable } from "@opencode-ai/core/event/sql"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionRunnerLLM } from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import {
  AbsolutePath,
  ApplicationTools,
  AgentV2,
  DateTime,
  EventV2,
  Location,
  Prompt,
  SessionStore,
  SessionV2,
  State,
  client,
  config,
  execution,
  fragmentFixture,
  insertSession,
  models,
  referenceGuidance,
  sessionID,
  setup,
  skillGuidance,
  systemContext,
  type LLMRequest,
} from "./session-runner.fixture"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const assertions: PermissionV2.AssertInput[] = []
const allowPermission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

// `FanoutDelivery` is in the graph because the last test here is about the push,
// not only the cursor: a result that lands after the parent compacts has to
// reach a parent whose own context was just rebuilt underneath it.
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      ApplicationTools.node,
      SessionProjector.node,
      SessionStore.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
      BackgroundJob.node,
      FanoutTool.node,
      FanoutDelivery.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [Config.node, config],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [PermissionV2.node, allowPermission],
      [ReferenceGuidance.node, referenceGuidance],
      [SessionExecution.node, execution],
      [SessionRunnerModel.node, models],
      [SkillGuidance.node, skillGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SystemContextRegistry.node, systemContext],
    ],
  ),
)

// Delivery is an event-driven push, so this waits for the push rather than
// assume it has already happened when the worker settles.
const eventually = <A, R>(effect: Effect.Effect<A, never, R>, accept: (value: A) => boolean) =>
  effect.pipe(
    Effect.flatMap((value) => (accept(value) ? Effect.succeed(value) : Effect.fail("not yet"))),
    Effect.retry({ times: 500, schedule: Schedule.spaced(5) }),
  )

const say = (id: string, text: string) => fragmentFixture("text", id, [text]).completeEvents

const call = (input: FanoutTool.Input) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-fanout", name: FanoutTool.name, input },
})

const crew = (count: number) => ({
  title: "audit",
  workers: Array.from({ length: count }, (_, index) => ({
    description: `job ${index}`,
    prompt: `Investigate area ${index} and report back.`,
  })),
})

const prepare = Effect.gen(function* () {
  yield* setup
  const { db } = yield* Database.Service
  yield* db.delete(FanoutWorkerTable).where(eq(FanoutWorkerTable.parent_session_id, sessionID)).run().pipe(Effect.orDie)
  yield* db.delete(FanoutGroupTable).where(eq(FanoutGroupTable.parent_session_id, sessionID)).run().pipe(Effect.orDie)
  yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).run().pipe(Effect.orDie)
  yield* insertSession(sessionID)
  return db
})

/** A manual compaction of the parent, published the way the automatic one is. */
const compact = Effect.fn(function* (summary: string) {
  const events = yield* EventV2.Service
  const messageID = SessionMessage.ID.create()
  yield* events.publish(SessionEvent.Compaction.Started, {
    sessionID,
    messageID,
    timestamp: yield* DateTime.now,
    reason: "manual",
  })
  yield* events.publish(SessionEvent.Compaction.Ended, {
    sessionID,
    messageID,
    timestamp: yield* DateTime.now,
    reason: "manual",
    text: summary,
    recent: "",
  })
})

/**
 * Launches a real crew through the real tool, so every worker is a genuine
 * `SessionV1.Event.Created` child session with `parentID` set, owned by a
 * background job, and still mid-flight behind `gate`.
 *
 * The gate is read when a worker's stream is called, which happens before
 * `settleTool` returns, so clearing `State.streamGate` afterwards releases the
 * parent's own turns without letting the workers answer.
 */
const launch = (digests: readonly string[]) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const gate = yield* Deferred.make<void>()
    State.responses = [
      ...digests.map((digest, index) => say(`worker-${index}`, digest)),
      ...Array.from({ length: 8 }, () => say("parent", "Noted, thanks.")),
    ]
    State.streamGate = gate
    const settled = yield* settleTool(registry, call(crew(digests.length)))
    expect(settled.result.type).toBe("text")
    const { db } = yield* Database.Service
    const rows = yield* db.select().from(FanoutWorkerTable).all().pipe(Effect.orDie)
    expect(rows).toHaveLength(digests.length)
    // Every worker turn is in flight and blocked, so nothing has answered yet.
    expect(State.requests).toHaveLength(digests.length)
    expect(yield* inbox()).toEqual([])
    State.streamGate = undefined
    return {
      gate,
      workerIDs: rows.map((row) => row.id),
      children: rows.map((row) => SessionV2.ID.make(row.session_id)),
    }
  })

const release = (gate: Deferred.Deferred<void>) => Deferred.succeed(gate, undefined)

const inbox = Effect.fn(function* () {
  const { db } = yield* Database.Service
  return yield* db
    .select({ id: SessionInputTable.id, delivery: SessionInputTable.delivery, prompt: SessionInputTable.prompt })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, sessionID))
    .all()
    .pipe(Effect.orDie)
})

/** The fan-out results pushed into the parent's inbox, with their delivery kind. */
const results = Effect.fn(function* () {
  return (yield* inbox())
    .map((row) => ({ delivery: row.delivery, text: JSON.stringify(row.prompt) }))
    .filter((row) => row.text.includes("fanout-result"))
})

/** A parent turn, answered by whatever response the queue hands out next. */
const turn = Effect.fn(function* (text: string) {
  const session = yield* SessionV2.Service
  yield* session.prompt({ sessionID, prompt: Prompt.make({ text }), resume: false })
  yield* session.resume(sessionID)
  return State.requests.at(-1)
})

const system = (request: LLMRequest | undefined) => (request?.system ?? []).map((part) => part.text).join("\n")

const user = (request: LLMRequest | undefined) =>
  (request?.messages ?? []).flatMap((message) =>
    message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
  )

const childMessages = Effect.fn(function* (children: readonly SessionV2.ID[]) {
  const { db } = yield* Database.Service
  return yield* db
    .select({ session: SessionMessageTable.session_id, type: SessionMessageTable.type })
    .from(SessionMessageTable)
    .where(inArray(SessionMessageTable.session_id, [...children]))
    .all()
    .pipe(Effect.orDie)
})

const childEvents = Effect.fn(function* (children: readonly SessionV2.ID[]) {
  const { db } = yield* Database.Service
  return yield* db
    .select({ aggregate: EventTable.aggregate_id, type: EventTable.type })
    .from(EventTable)
    .where(inArray(EventTable.aggregate_id, [...children]))
    .all()
    .pipe(Effect.orDie)
})

const childRows = Effect.fn(function* (children: readonly SessionV2.ID[]) {
  const { db } = yield* Database.Service
  return yield* db
    .select({ id: SessionTable.id, parent: SessionTable.parent_id })
    .from(SessionTable)
    .where(inArray(SessionTable.id, [...children]))
    .all()
    .pipe(Effect.orDie)
})

describe("FanoutContext across compaction", () => {
  it.live("compacting the parent leaves every child session and its ledger row untouched", () =>
    Effect.gen(function* () {
      const db = yield* prepare
      const jobs = yield* BackgroundJob.Service
      const store = yield* SessionStore.Service
      const { gate, workerIDs, children } = yield* launch(["Area 0 is fine.", "Area 1 is fine."])
      // Real children of the parent, not siblings that merely share a ledger.
      expect((yield* childRows(children)).map((row) => row.parent)).toEqual([sessionID, sessionID])

      yield* turn("start the audit")
      expect(system(State.requests.at(-1))).toContain(
        "2 worker(s) live across 1 group(s), 0 finished result(s) not yet delivered",
      )

      // What a compaction of the parent must not reach: each child's
      // transcript, each child's event stream, and the ledger row that says it
      // is still running.
      const beforeMessages = yield* childMessages(children)
      const beforeEvents = yield* childEvents(children)
      const beforeContext = yield* Effect.forEach(children, (child) => store.context(child))
      expect(beforeMessages.map((row) => row.type)).toEqual(["user", "user"])
      expect(beforeContext.every((context) => context.length === 1)).toBe(true)

      yield* compact("Earlier turns: the user asked for an audit.")

      // No cascade. Compaction is a message in the parent's own history: no
      // child aggregate gains an event, and no child is compacted or cancelled.
      expect(yield* childMessages(children)).toEqual(beforeMessages)
      expect(yield* childEvents(children)).toEqual(beforeEvents)
      for (const [index, child] of children.entries()) {
        const context = yield* store.context(child)
        expect(context).toHaveLength(beforeContext[index].length)
        expect(context).toEqual(beforeContext[index])
        expect(context.some((message) => message.type === "compaction")).toBe(false)
      }

      // The crew is untouched: same rows, still live, still owned by running
      // jobs, still the parent's, and its cap slot is not held by a corpse.
      expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 1, live: 2, unclaimed: 0 })
      for (const id of workerIDs) expect(yield* FanoutLedger.findWorker(db, id)).toMatchObject({ status: "live" })
      expect((yield* jobs.list()).map((job) => job.status).sort()).toEqual(["running", "running"])
      const group = (yield* FanoutLedger.groups(db, sessionID))[0]
      expect(yield* FanoutLedger.findGroup(db, group.id)).toMatchObject({ status: "live" })
      expect((yield* FanoutLedger.groupWorkers(db, group.id)).map((worker) => worker.sessionID).sort()).toEqual(
        [...children].sort(),
      )
      expect(yield* FanoutLedger.live(db, sessionID)).toHaveLength(2)

      // Released only now, so the workers are provably still mid-flight for
      // every assertion above rather than having finished quietly in between.
      yield* release(gate)
    }),
  )

  it.live("a worker that finishes after the parent compacts is still delivered", () =>
    Effect.gen(function* () {
      const db = yield* prepare
      const jobs = yield* BackgroundJob.Service
      const { gate, workerIDs } = yield* launch(["Area 0 has two failing tests.", "Area 1 is clean."])

      yield* turn("start the audit")
      expect(system(State.requests.at(-1))).toContain(
        "2 worker(s) live across 1 group(s), 0 finished result(s) not yet delivered",
      )

      // The parent compacts with both workers still running. A compaction is a
      // summary of the PARENT's transcript; it has nothing to say about work
      // that has not finished, and it must not be able to swallow a result
      // that lands after it.
      yield* compact("Earlier turns: the user asked for an audit.")
      expect(yield* results()).toEqual([])

      yield* release(gate)
      for (const job of yield* jobs.list()) yield* jobs.wait({ id: job.id })

      // Both workers settled after the compaction, and the push still landed.
      for (const id of workerIDs) expect(yield* FanoutLedger.findWorker(db, id)).toMatchObject({ status: "done" })
      const delivered = yield* eventually(results(), (rows) => rows.length === 2)
      expect(delivered.every((row) => row.delivery === "steer")).toBe(true)
      expect(delivered.some((row) => row.text.includes("Area 0 has two failing tests."))).toBe(true)
      expect(delivered.some((row) => row.text.includes("Area 1 is clean."))).toBe(true)
      expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 1, live: 0, unclaimed: 0 })

      // And the parent was actually woken and shown them: a digest sitting in
      // the inbox is not the same as a parent that knows about it.
      const firstWith = (needle: string) =>
        State.requests.findIndex((request) => user(request).some((text) => text.includes(needle)))
      yield* eventually(
        Effect.sync(() => firstWith("Area 1 is clean.")),
        (index) => index >= 0,
      )
      expect(firstWith("Area 0 has two failing tests.")).toBeGreaterThanOrEqual(0)
      // The digests were admitted after the compaction, so the turn that shows
      // them is answered from the compacted history: they were delivered INTO
      // the rebuilt context, not into the transcript compaction threw away.
      expect(firstWith("Earlier turns:")).toBeGreaterThanOrEqual(0)
      expect(firstWith("fanout-result")).toBeGreaterThanOrEqual(firstWith("Earlier turns:"))
      expect(firstWith("start the audit")).toBeLessThan(firstWith("Earlier turns:"))
      // And the rebuilt baseline is the one the parent is reasoning with, not a
      // fossil of the pre-compaction one: the ledger had already moved by the
      // time this turn was assembled, because a digest was claimed before the
      // parent was woken.
      const rebuilt = State.requests[firstWith("fanout-result")]
      const crew = /(\d+) worker\(s\) live across 1 group\(s\)/.exec(system(rebuilt))
      expect(crew).not.toBeNull()
      expect(Number(crew![1])).toBeLessThanOrEqual(1)
    }),
  )
})
