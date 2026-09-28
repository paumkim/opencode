import { Cause, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "@opencode-ai/core/agent"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { Database } from "@opencode-ai/core/database/database"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { FanoutDigest } from "@opencode-ai/core/fanout/digest"
import { FanoutLedger } from "@opencode-ai/core/fanout/ledger"
import { FanoutLifecycle } from "@opencode-ai/core/fanout/lifecycle"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionRunnerLLM } from "@opencode-ai/core/session/runner/llm"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Tools } from "@opencode-ai/core/tool/tools"
import { Slug } from "@opencode-ai/core/util/slug"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"

export const name = "crew"

export interface CrewServices {
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly jobs: BackgroundJob.Interface
  readonly runner: SessionRunner.Interface
  readonly agents: AgentV2.Interface
}

export const crewServices = Effect.gen(function* () {
  return {
    ...(yield* Database.Service),
    events: yield* EventV2.Service,
    jobs: yield* BackgroundJob.Service,
    runner: yield* SessionRunner.Service,
    agents: yield* AgentV2.Service,
  }
})

/**
 * Launches a fan-out crew without a tool in the loop.
 *
 * This is deliberately not a second delegation mechanism and it lives in `test`
 * for that reason. It does the four things a crew needs to exist -- materialise
 * child sessions, record them in the durable ledger, start a background job per
 * worker, settle the digest when a worker finishes -- driven straight from a
 * test. What the tests that use it are about is what happens to a crew that is
 * already in flight (compaction must not touch it, delivery must still reach
 * the parent, the coordinator must not be held), and routing a tool to get
 * there only adds a moving part between the test and the property.
 */
export const launchCrew = (
  services: CrewServices,
  input: {
    readonly parent: SessionSchema.ID
    readonly title: string
    readonly workers: ReadonlyArray<{ readonly description: string; readonly prompt: string }>
  },
) =>
  Effect.gen(function* () {
    const { db, events, jobs, runner, agents } = services
    const parent = yield* db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, input.parent))
      .get()
      .pipe(Effect.orDie)
    if (!parent) return yield* Effect.die(new Error(`Session not found: ${input.parent}`))

    const group = yield* FanoutLifecycle.open(db, events, { parentSessionID: input.parent, title: input.title })
    const selected = yield* agents.select(undefined)

    return yield* Effect.forEach(input.workers, (worker) =>
      Effect.gen(function* () {
        const childID = SessionSchema.ID.create()
        const now = Date.now()
        yield* events.publish(
          SessionV1.Event.Created,
          {
            sessionID: childID,
            info: SessionV1.SessionInfo.make({
              id: childID,
              slug: Slug.create(),
              projectID: parent.project_id,
              workspaceID: parent.workspace_id ?? undefined,
              directory: parent.directory,
              path: parent.path ?? undefined,
              parentID: parent.id,
              title: worker.description,
              agent: selected.id,
              model: parent.model
                ? {
                    id: ModelV2.ID.make(parent.model.id),
                    providerID: ProviderV2.ID.make(parent.model.providerID),
                    ...(parent.model.variant === null || parent.model.variant === undefined
                      ? {}
                      : { variant: parent.model.variant }),
                  }
                : undefined,
              version: parent.version,
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: now, updated: now },
            }),
          },
          {
            location: Location.Ref.make({
              directory: AbsolutePath.make(parent.directory),
              ...(parent.workspace_id === null ? {} : { workspaceID: WorkspaceV2.ID.make(parent.workspace_id) }),
            }),
          },
        )
        // Admitted but not woken: the background job below owns this session's
        // drain, so nothing can race it for a turn.
        yield* SessionInput.admit(db, events, {
          id: SessionMessage.ID.create(),
          sessionID: childID,
          prompt: { text: worker.prompt },
          delivery: "queue",
        })
        const record = yield* FanoutLifecycle.join(db, events, {
          groupID: group.id,
          parentSessionID: input.parent,
          sessionID: childID,
          description: worker.description,
        })
        yield* jobs.start({
          id: childID,
          type: name,
          title: worker.description,
          metadata: {
            groupID: group.id,
            workerID: record.id,
            sessionId: childID,
            parentSessionId: input.parent,
          },
          run: supervise(db, events, record, runner.run({ sessionID: childID, force: false })),
        })
        return record
      }),
    )
  })

/**
 * Runs a worker to completion and records its digest.
 *
 * The parent is already gone by the time this runs, so a worker's failure still
 * has to reach the ledger; delivery is somebody else's job.
 */
export const supervise = (
  db: Database.Interface["db"],
  events: EventV2.Interface,
  worker: FanoutLedger.Worker,
  run: Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    const exit = yield* run.pipe(Effect.exit)
    const squashed = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
    const failure =
      squashed === undefined ? undefined : squashed instanceof Error ? squashed.message : JSON.stringify(squashed)
    const digest = failure === undefined ? yield* FanoutDigest.ofSession(db, worker.sessionID) : undefined
    yield* FanoutLifecycle.settle(db, events, {
      workerID: worker.id,
      status: digest === undefined ? "error" : "done",
      ...(digest === undefined
        ? {
            error: FanoutDigest.failure(failure ?? "the worker produced no result"),
          }
        : { digest }),
    }).pipe(
      // The parent is already gone; losing its crew's record to a transient
      // failure here is the one unrecoverable outcome, so this is logged and
      // swallowed rather than left to kill an unobserved background fiber.
      Effect.catchCause((cause) => Effect.logError("Fan-out result could not be recorded", cause).pipe(Effect.asVoid)),
    )
    return worker.id
  })

const register = Effect.gen(function* () {
  const tools = yield* ApplicationTools.Service
  const permission = yield* PermissionV2.Service
  // Closed over at registration, the way a Location tool's own layer does:
  // `Tool.make` gives `execute` no way to require services, so they are resolved
  // here from the graph this registration happened in.
  const services = yield* crewServices
  yield* tools
    .register({
      [name]: Tool.make({
        description: "Launch a crew of background workers and return immediately.",
        input: Schema.Struct({
          title: Schema.String,
          workers: Schema.Array(Schema.Struct({ description: Schema.String, prompt: Schema.String })),
        }),
        output: Schema.Struct({ workers: Schema.Array(Schema.String) }),
        // The model-facing answer has to say the crew is running, not report its
        // output: a tool that returned a transcript would be indistinguishable
        // from one that parked the parent.
        toModelOutput: () => [
          {
            type: "text",
            text: "The crew is running in the background. You are free to keep working and to answer the user now. Do not sleep, poll, or ask for status.",
          },
        ],
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* permission
              .assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(Effect.mapError((error) => new Tool.Failure({ message: error.message })))
            const records = yield* launchCrew(services, { parent: context.sessionID, ...input }).pipe(
              // A crew that cannot be recorded is a loud failure, never a silent
              // truncation -- the same rule the caps enforce.
              Effect.mapError((error) =>
                error instanceof Tool.Failure ? error : new Tool.Failure({ message: String(error) }),
              ),
            )
            return { workers: records.map((record) => record.id) }
          }),
      }),
    })
    .pipe(Effect.orDie)
})

/**
 * A Location-scoped `Tools` registry that also knows the crew tool, for tests
 * that need a crew reached from inside a real parent turn rather than driven
 * directly.
 *
 * The production delegation tool is the v1 `task` tool; this exists so a v2 test
 * can still observe "a crew launched from a tool does not hold the parent's
 * turn" without shipping a second delegation mechanism in `src`. It substitutes
 * for `ToolRegistry.toolsNode` -- the registry the real Location graph builds --
 * and keeps that registry's own layer, so the crew tool is reached the way any
 * other Location tool is.
 */
export const tools = makeLocationNode({
  service: Tools.Service,
  layer: Layer.effectDiscard(register).pipe(
    Layer.provideMerge(
      // Built the way `ToolRegistry.toolsNode` builds it: the real registry,
      // narrowed to the registration half. A tool registered into
      // `ApplicationTools` here lands in the same place the Location graph's
      // `ToolRegistry` reads from, so the crew tool is reached like any other.
      Layer.effect(
        Tools.Service,
        ToolRegistry.Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
      ),
    ),
  ),
  deps: [
    ToolRegistry.node,
    ApplicationTools.node,
    ToolOutputStore.node,
    PermissionV2.node,
    AgentV2.node,
    SessionRunnerLLM.node,
    Database.node,
    EventV2.node,
    BackgroundJob.node,
  ],
})
