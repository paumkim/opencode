import { describe, expect } from "bun:test"
import fs from "fs/promises"
import { rmSync } from "fs"
import { tmpdir as osTmpdir } from "os"
import path from "path"
import { Deferred, Effect, Exit, Fiber, Layer, Schedule, Stream } from "effect"
import { eq } from "drizzle-orm"
import { LLMEvent } from "@opencode-ai/llm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { FanoutDelivery } from "@opencode-ai/core/fanout/delivery"
import { FanoutLedger } from "@opencode-ai/core/fanout/ledger"
import { FanoutGroupTable, FanoutWorkerTable } from "@opencode-ai/core/fanout/sql"
import { FanoutTool } from "@opencode-ai/core/tool/fanout"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import * as SessionExecutionLocal from "@opencode-ai/core/session/execution/local"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionV2 } from "@opencode-ai/core/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Project } from "@opencode-ai/core/project"
import {
  AbsolutePath,
  State,
  client,
  config,
  models,
  referenceGuidance,
  sessionID,
  setup,
  skillGuidance,
  systemContext,
} from "./session-runner.fixture"
import { testEffect } from "./lib/effect"

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

/**
 * The crew is held so the parent can be observed mid-flight. This is the same
 * shape as the fixture's `streamGate`: nothing is gated until a test asks for
 * it, and the gate is read when a job is registered rather than when it starts.
 */
const crew = { gate: undefined as Deferred.Deferred<void> | undefined }

const gatedBackground = Layer.effect(
  BackgroundJob.Service,
  Effect.gen(function* () {
    const registry = yield* BackgroundJob.make
    return BackgroundJob.Service.of({
      ...registry,
      start: (input) =>
        registry.start({
          ...input,
          run: Effect.suspend(() =>
            crew.gate === undefined ? input.run : Deferred.await(crew.gate).pipe(Effect.andThen(input.run)),
          ),
        }),
    })
  }),
)

/**
 * The shipped Location graph is real here, so it touches a real directory. A
 * temp project keeps that honest instead of stubbing the filesystem away.
 */
const project = AbsolutePath.make(
  await fs.realpath(await fs.mkdtemp(path.join(osTmpdir(), "opencode-fanout-non-blocking-"))),
)
process.on("exit", () => {
  rmSync(project, { recursive: true, force: true })
})

/**
 * Production topology, with only the model boundary faked.
 *
 * The important half of that is real: `SessionExecutionLocal` -- the real
 * coordinator, its FiberSet and its coalescing -- sits where the app puts it,
 * and `fanout` is reached through a real `LocationServiceMap`, so the tool is a
 * Location node executed by the real `SessionRunner` inside a real parent turn
 * rather than settled directly.
 */
const locationMap = buildLocationServiceMap([
  [LayerNodePlatform.llmClient, client],
  [Config.node, config],
  [PermissionV2.node, allowPermission],
  [ReferenceGuidance.node, referenceGuidance],
  [SessionRunnerModel.node, models],
  [SkillGuidance.node, skillGuidance],
  [Snapshot.node, Snapshot.noopLayer],
  [SystemContextRegistry.node, systemContext],
  [BackgroundJob.node, gatedBackground],
])

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionExecution.node,
      SessionV2.node,
      BackgroundJob.node,
      FanoutDelivery.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [Config.node, config],
      [BackgroundJob.node, gatedBackground],
      [LocationServiceMap.node, locationMap],
      [PermissionV2.node, allowPermission],
      [ReferenceGuidance.node, referenceGuidance],
      [SessionExecution.node, SessionExecutionLocal.node],
      [SessionRunnerModel.node, models],
      [SkillGuidance.node, skillGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SystemContextRegistry.node, systemContext],
    ],
  ),
)

const eventually = <A, R>(effect: Effect.Effect<A, never, R>, accept: (value: A) => boolean) =>
  effect.pipe(
    Effect.flatMap((value) => (accept(value) ? Effect.succeed(value) : Effect.fail("not yet"))),
    Effect.retry({ times: 500, schedule: Schedule.spaced(5) }),
  )

const say = (id: string, text: string) => fragment("text", id, [text])

function fragment(kind: "text", id: string, chunks: readonly string[]) {
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id }),
    ...chunks.map((text) => LLMEvent.textDelta({ id, text })),
    LLMEvent.textEnd({ id }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ]
}

const callFanout = () => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({
    id: "call-fanout",
    name: FanoutTool.name,
    input: {
      title: "audit",
      workers: [
        { description: "job 0", prompt: "Investigate area 0 and report back." },
        { description: "job 1", prompt: "Investigate area 1 and report back." },
      ],
    },
  }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const prepare = Effect.gen(function* () {
  yield* setup
  crew.gate = undefined
  assertions.length = 0
  const { db } = yield* Database.Service
  yield* db.delete(FanoutWorkerTable).where(eq(FanoutWorkerTable.parent_session_id, sessionID)).run().pipe(Effect.orDie)
  yield* db.delete(FanoutGroupTable).where(eq(FanoutGroupTable.parent_session_id, sessionID)).run().pipe(Effect.orDie)
  yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).run().pipe(Effect.orDie)
  // The fixture's session points at a directory that does not exist; the real
  // Location graph needs the one this test created.
  yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory: project,
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const session = yield* SessionV2.Service
  yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Audit both areas." }), resume: false })
  return db
})

const userTexts = Effect.sync(() =>
  State.requests.flatMap((request) =>
    request.messages.flatMap((message) =>
      message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
    ),
  ),
)

const inbox = Effect.fn(function* () {
  const { db } = yield* Database.Service
  return yield* db
    .select({ id: SessionInputTable.id, delivery: SessionInputTable.delivery, prompt: SessionInputTable.prompt })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, sessionID))
    .all()
    .pipe(Effect.orDie)
})

describe("fan-out from a real parent turn", () => {
  it.live("the turn settles and the coordinator drops the parent while the crew is still running", () =>
    Effect.gen(function* () {
      const db = yield* prepare
      const execution = yield* SessionExecution.Service
      const jobs = yield* BackgroundJob.Service
      const gate = yield* Deferred.make<void>()
      crew.gate = gate
      State.responses = [
        callFanout(),
        say("parent", "Crew is running. I will keep working."),
        say("worker-a", "Area 0 has two failing tests."),
        say("worker-b", "Area 1 is clean."),
        ...Array.from({ length: 8 }, () => say("parent", "Both areas reported.")),
      ]

      // THE POINT: this is the parent's own turn, not a direct `settleTool`
      // call, and it finishes on its own.
      yield* execution.resume(sessionID)

      // The parent is not held by the fan-out. The coordinator has no entry for
      // it, so nothing about the crew is on the parent's critical path.
      expect(yield* execution.active).toEqual(new Set())
      expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 1, live: 2, unclaimed: 0 })
      expect((yield* jobs.list()).map((job) => job.status)).toEqual(["running", "running"])
      // What the parent read back: the crew is running, not the crew's output.
      expect(JSON.stringify(State.requests[1]?.messages)).toContain("running in the background")
      expect(assertions).toMatchObject([{ sessionID, action: FanoutTool.name, resources: ["*"] }])
      // The parent's turn really is a completed turn, with the crew still live.
      // The parent's turn really is a completed turn, and the tool's own answer
      // -- the one the model read back -- reports a crew that is still running.
      expect(yield* (yield* SessionV2.Service).context(sessionID)).toMatchObject([
        { type: "user", text: "Audit both areas." },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              name: FanoutTool.name,
              state: {
                status: "completed",
                content: [{ type: "text", text: expect.stringContaining("running in the background") }],
              },
            },
          ],
        },
        { type: "system" },
        { type: "assistant", finish: "stop" },
      ])

      // Only now does the crew get to run.
      yield* Deferred.succeed(gate, undefined)
      for (const job of yield* jobs.list()) yield* jobs.wait({ id: job.id })

      // The delivery node woke the parent, so the digests reach it as a turn
      // nobody asked for.
      const delivered = yield* eventually(inbox(), (rows) => rows.length >= 2)
      expect(delivered.every((row) => row.delivery === "steer")).toBe(true)
      const texts = yield* eventually(userTexts, (all) =>
        all.some((text) => text.includes("Area 0 has two failing tests.")) &&
        all.some((text) => text.includes("Area 1 is clean.")),
      )
      expect(texts.some((text) => text.includes("Area 0 has two failing tests."))).toBe(true)
      expect(texts.some((text) => text.includes("Area 1 is clean."))).toBe(true)
      expect(yield* FanoutLedger.cursor(db, sessionID)).toEqual({ groups: 1, live: 0, unclaimed: 0 })
      expect(yield* execution.active).toEqual(new Set())
    }),
  )
})

/**
 * The coordinator's phase contract, on its own so the ordering guarantees are
 * pinned down without a Session in the way.
 *
 * A client latches busy on `started` and releases on the terminal phase, so a
 * terminal phase that overtakes a `started` leaves it latched busy for the life
 * of the page. Everything here is about the shape of that window.
 */
const coordinatorFor = (drain: (key: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const seen: string[] = []
    const coordinator = yield* SessionRunCoordinator.make<string, string>({
      drain,
      lifecycle: (key, phase) => Effect.sync(() => seen.push(`${key}:${phase.type}`)),
    })
    return { coordinator, seen }
  })

describe("SessionRunCoordinator phases", () => {
  it.live("a wake that lands mid-turn keeps the key busy instead of dropping it", () =>
    Effect.gen(function* () {
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      let drains = 0
      const { coordinator, seen } = yield* coordinatorFor(() =>
        Effect.gen(function* () {
          const attempt = ++drains
          yield* Deferred.await(attempt === 1 ? first : second)
        }),
      )

      // `Effect.exit` so an abort is the result under test rather than a test failure.
      const running = yield* Effect.forkChild(Effect.exit(coordinator.run("ses_phase")))
      yield* eventually(Effect.sync(() => drains), (count) => count === 1)

      // Two wakes for work that arrived while the turn was still running. The
      // coordinator coalesces them into one successor, and the Session is never
      // reported idle in between -- it never was idle.
      yield* coordinator.wake("ses_phase")
      yield* coordinator.wake("ses_phase")
      yield* Deferred.succeed(first, undefined)
      yield* eventually(Effect.sync(() => drains), (count) => count === 2)
      expect(seen).toEqual(["ses_phase:started"])
      expect(yield* coordinator.active).toEqual(new Set(["ses_phase"]))

      yield* Deferred.succeed(second, undefined)
      expect(Exit.isSuccess(yield* Fiber.join(running))).toBe(true)
      expect(drains).toBe(2)
      expect(seen).toEqual(["ses_phase:started", "ses_phase:ended"])
      expect(yield* coordinator.active).toEqual(new Set())
    }),
  )

  it.live("an interrupted turn is reported as a terminal phase, not a success", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const seen: string[] = []
      const coordinator = yield* SessionRunCoordinator.make<string, string>({
        drain: () => Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Effect.never
        }),
        lifecycle: (key, phase) =>
          Effect.sync(() => {
            seen.push(`${key}:${phase.type}`)
            if (phase.type === "ended") seen.push(`failed:${Exit.isFailure(phase.exit)}`)
          }),
      })

      // `Effect.exit` so an abort is the result under test rather than a test failure.
      const running = yield* Effect.forkChild(Effect.exit(coordinator.run("ses_phase")))
      yield* Deferred.await(entered)
      yield* coordinator.interrupt("ses_phase")
      expect(Exit.isFailure(yield* Fiber.join(running))).toBe(true)

      expect(seen).toEqual(["ses_phase:started", "ses_phase:ended", "failed:true"])
      expect(yield* coordinator.active).toEqual(new Set())
    }),
  )
})

/**
 * The published wire contract: a real turn's busy window, with the Session's
 * Location attached so the event stream (which filters by directory) carries it.
 */
const record = Effect.fn(function* (definitions: readonly EventV2.Definition[]) {
  const events = yield* EventV2.Service
  const seen: string[] = []
  for (const definition of definitions) {
    yield* events
      .subscribe(definition)
      .pipe(
        Stream.mapEffect((event) => Effect.sync(() => void seen.push(`${event.type}@${event.location?.directory}`))),
        Stream.runDrain,
        Effect.forkScoped,
      )
  }
  return seen
})

const phaseDefinitions = [
  SessionEvent.Execution.Started,
  SessionEvent.Execution.Succeeded,
  SessionEvent.Execution.Failed,
  SessionEvent.Execution.Interrupted,
] as const

describe("published session execution phases", () => {
  it.live("a finished turn reports started then succeeded", () =>
    Effect.gen(function* () {
      yield* prepare
      const execution = yield* SessionExecution.Service
      const seen = yield* record(phaseDefinitions)
      State.responses = [say("turn", "All done.")]

      yield* execution.resume(sessionID)

      expect(seen).toEqual([`session.execution.started@${project}`, `session.execution.succeeded@${project}`])
      expect(yield* execution.active).toEqual(new Set())
    }),
  )

  it.live("an aborted turn reports interrupted, and the Session ends up idle", () =>
    Effect.gen(function* () {
      yield* prepare
      const execution = yield* SessionExecution.Service
      const seen = yield* record(phaseDefinitions)
      const gate = yield* Deferred.make<void>()
      const streaming = yield* Deferred.make<void>()
      State.streamGate = gate
      State.streamStarted = streaming

      const running = yield* Effect.forkChild(Effect.exit(execution.resume(sessionID)))
      yield* Deferred.await(streaming)
      yield* execution.interrupt(sessionID)
      expect(Exit.isFailure(yield* Fiber.join(running))).toBe(true)
      yield* Deferred.succeed(gate, undefined)

      expect(seen).toEqual([`session.execution.started@${project}`, `session.execution.interrupted@${project}`])
      expect(yield* execution.active).toEqual(new Set())
    }),
  )
})
