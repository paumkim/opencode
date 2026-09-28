import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Schedule, Schema } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { Config } from "@opencode-ai/core/config"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { Database } from "@opencode-ai/core/database/database"
import { FanoutDelivery } from "@opencode-ai/core/fanout/delivery"
import { FanoutLedger } from "@opencode-ai/core/fanout/ledger"
import { FanoutLifecycle } from "@opencode-ai/core/fanout/lifecycle"
import { FanoutGroupTable, FanoutWorkerTable } from "@opencode-ai/core/fanout/sql"
import { FanoutTool } from "@opencode-ai/core/tool/fanout"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Layer } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionRunnerLLM } from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import {
  AbsolutePath,
  ApplicationTools,
  AgentV2,
  Database as DatabaseService,
  EventV2,
  Location,
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
} from "./session-runner.fixture"
import { testEffect } from "./lib/effect"
import { toolIdentity } from "./lib/tool"
import { settleTool, toolDefinitions } from "./lib/tool"

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

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      DatabaseService.node,
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

// Delivery is an event-driven push, so these tests wait for the push rather
// than assume it has already happened when the worker settles.
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

const inbox = Effect.fn(function* () {
  const { db } = yield* Database.Service
  return yield* db
    .select({ id: SessionInputTable.id, delivery: SessionInputTable.delivery, prompt: SessionInputTable.prompt })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, sessionID))
    .all()
    .pipe(Effect.orDie)
})

const writeAnswer = (session: SessionV2.ID, seq: number, text: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const { type, ...data } = Schema.encodeSync(SessionMessage.Message)(
      SessionMessage.Assistant.make({
        id: SessionMessage.ID.create(),
        type: "assistant",
        agent: "build",
        model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
        content: [{ type: "text", id: "text", text }],
        time: { created: DateTime.makeUnsafe(0) },
      }),
    )
    const row: typeof SessionMessageTable.$inferInsert = {
      id: SessionMessage.ID.create(),
      session_id: session,
      type,
      seq,
      time_created: 0,
      data,
    }
    yield* db.insert(SessionMessageTable).values(row).onConflictDoNothing().run().pipe(Effect.orDie)
  })

describe("FanoutTool", () => {
  it.effect("is advertised to a parent as a built-in tool", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([FanoutTool.name])
    }),
  )

  it.live("returns while the whole crew is still running, then delivers each digest as a steer", () =>
    Effect.gen(function* () {
      const db = yield* prepare
      const registry = yield* ToolRegistry.Service
      const jobs = yield* BackgroundJob.Service
      assertions.length = 0
      const gate = yield* Deferred.make<void>()
      State.streamGate = gate
      State.responses = [
        say("worker-a", "Area 0 has two failing tests."),
        say("worker-b", "Area 1 is clean."),
        ...Array.from({ length: 8 }, () => say("parent", "Noted, thanks.")),
      ]

      const settled = yield* settleTool(registry, call(crew(2)))
      expect(settled.result.type).toBe("text")
      expect(assertions).toMatchObject([{ sessionID, action: FanoutTool.name, resources: ["*"] }])
      // What the parent reads back on its very next step: the crew's identity,
      // the instruction not to poll, and no fabricated output.
      expect(settled.result).toMatchObject({ type: "text" })
      const modelText = settled.result.type === "text" ? settled.result.value : ""
      expect(modelText).toContain("running in the background")
      expect(modelText).toContain("Do not sleep, poll, or ask for status")
      expect(settled.output?.structured).toMatchObject({ title: "audit" })

      // THE POINT: the call returned with the crew still mid-flight. A blocking
      // delegation would sit here until the provider answered.
      expect(State.requests).toHaveLength(2)
      expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 1, live: 2, unclaimed: 0 })
      expect((yield* jobs.list()).map((job) => job.status)).toEqual(["running", "running"])
      expect(yield* inbox()).toEqual([])

      yield* Deferred.succeed(gate, undefined)
      for (const job of yield* jobs.list()) yield* jobs.wait({ id: job.id })

      expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 1, live: 0, unclaimed: 0 })
      const delivered = yield* eventually(inbox(), (rows) => rows.length === 2)
      expect(delivered).toHaveLength(2)
      expect(delivered.every((row) => row.delivery === "steer")).toBe(true)
      const prompts = delivered.map((row) => JSON.stringify(row.prompt))
      expect(prompts.some((text) => text.includes("Area 0 has two failing tests."))).toBe(true)
      expect(prompts.some((text) => text.includes("Area 1 is clean."))).toBe(true)
      // Each digest points at the child session rather than copying it.
      expect(prompts.every((text) => text.includes("full transcript stays in session"))).toBe(true)
    }),
  )

  it.live("gives the parent a turn carrying both digests, without the user prompting", () =>
    Effect.gen(function* () {
      const db = yield* prepare
      const registry = yield* ToolRegistry.Service
      const jobs = yield* BackgroundJob.Service
      State.responses = [
        say("worker-a", "Alpha result."),
        say("worker-b", "Beta result."),
        ...Array.from({ length: 8 }, () => say("parent", "Acknowledged.")),
      ]

      yield* settleTool(registry, call(crew(2)))
      for (const job of yield* jobs.list()) yield* jobs.wait({ id: job.id })
      // The delivery node woke the parent, so both steers are promoted into
      // real turns. Nothing had to ask the parent to look.
      const promoted = yield* eventually(
        Effect.sync(() =>
          State.requests.flatMap((request) =>
            request.messages.flatMap((message) =>
              message.role === "user"
                ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
                : [],
            ),
          ),
        ),
        (texts) =>
          texts.some((text) => text.includes("Alpha result.")) && texts.some((text) => text.includes("Beta result.")),
      )
      expect(promoted.some((text) => text.includes("Alpha result."))).toBe(true)
      expect(promoted.some((text) => text.includes("Beta result."))).toBe(true)
      expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 1, live: 0, unclaimed: 0 })
    }),
  )

  it.live("refuses a fifth worker in one group and a fourth concurrent group", () =>
    Effect.gen(function* () {
      const db = yield* prepare
      const registry = yield* ToolRegistry.Service
      const jobs = yield* BackgroundJob.Service
      assertions.length = 0
      const gate = yield* Deferred.make<void>()
      State.streamGate = gate
      State.responses = Array.from({ length: 64 }, () => say("hold", "Working."))

      const tooWide = yield* settleTool(registry, call(crew(5)))
      expect(tooWide.result.type).toBe("error")
      expect(JSON.stringify(tooWide.result)).toContain("at most 4 workers")
      expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 0, live: 0, unclaimed: 0 })

      for (let group = 0; group < 3; group++)
        expect((yield* settleTool(registry, call({ ...crew(1), title: `crew ${group}` }))).result.type).toBe("text")
      const overflow = yield* settleTool(registry, call({ ...crew(1), title: "overflow" }))
      expect(overflow.result.type).toBe("error")
      expect(JSON.stringify(overflow.result)).toContain("3 of 3")
      expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 3, live: 3, unclaimed: 0 })

      yield* Deferred.succeed(gate, undefined)
      for (const job of yield* jobs.list()) yield* jobs.wait({ id: job.id })
    }),
  )

  it.live("reclaims a crew the ledger calls live after the process that ran it died", () =>
    Effect.gen(function* () {
      const db = yield* prepare
      const events = yield* EventV2.Service
      const jobs = yield* BackgroundJob.Service
      const group = yield* FanoutLifecycle.open(db, events, { parentSessionID: sessionID, title: "audit" })
      const child = yield* (yield* SessionV2.Service).create({ location: { directory: "/project" } as never })
      const worker = yield* FanoutLifecycle.join(db, events, {
        groupID: group.id,
        parentSessionID: sessionID,
        sessionID: child.id,
        description: "job 0",
      })
      // The child answered before the process went away, so its answer is
      // recoverable; the ledger row is all that thinks it is still running.
      yield* writeAnswer(child.id, 1, "Recovered from the child's own transcript.")
      expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 1, live: 1, unclaimed: 0 })

      expect(yield* FanoutTool.reclaim(db, events, jobs, sessionID)).toEqual([worker.id])
      expect(yield* FanoutLedger.findWorker(db, worker.id)).toMatchObject({
        status: "done",
        digest: "Recovered from the child's own transcript.",
      })
      expect(yield* FanoutLedger.findGroup(db, group.id)).toMatchObject({ status: "settled" })
      // A reclaimed result is still a real result, so it is pushed like any other.
      const delivered = yield* eventually(inbox(), (rows) => rows.length === 1)
      expect(JSON.stringify(delivered[0].prompt)).toContain("Recovered from the child's own transcript.")
      expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 1, live: 0, unclaimed: 0 })
    }),
  )

  it.live("refuses to fan out from a session that is itself a worker", () =>
    Effect.gen(function* () {
      const db = yield* prepare
      const registry = yield* ToolRegistry.Service
      const events = yield* EventV2.Service
      const group = yield* FanoutLifecycle.open(db, events, { parentSessionID: sessionID, title: "audit" })
      const nested = yield* (yield* SessionV2.Service).create({ location: { directory: "/project" } as never })
      yield* FanoutLifecycle.join(db, events, {
        groupID: group.id,
        parentSessionID: sessionID,
        sessionID: nested.id,
        description: "job 0",
      })

      const settled = yield* settleTool(registry, { ...call(crew(1)), sessionID: nested.id })
      expect(settled.result.type).toBe("error")
      expect(JSON.stringify(settled.result)).toContain("itself a fan-out worker")
    }),
  )
})
