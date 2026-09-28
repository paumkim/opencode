export * as FanoutTool from "./fanout"

import { ToolFailure } from "@opencode-ai/llm"
import { Cause, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Fanout } from "@opencode-ai/schema/fanout"
import { makeLocationNode } from "../effect/app-node"
import { AgentV2 } from "../agent"
import { BackgroundJob } from "../background-job"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { FanoutDigest } from "../fanout/digest"
import { FanoutLedger } from "../fanout/ledger"
import { FanoutLifecycle } from "../fanout/lifecycle"
import { FanoutLimits } from "../fanout/limits"
import { ModelV2 } from "../model"
import { PermissionV2 } from "../permission"
import { Location } from "../location"
import { AbsolutePath } from "../schema"
import { WorkspaceV2 } from "../workspace"
import { ProviderV2 } from "../provider"
import { SessionInput } from "../session/input"
import { SessionMessage } from "../session/message"
import { SessionProjector } from "../session/projector"
import { SessionRunner } from "../session/runner"
import { SessionRunnerLLM } from "../session/runner/llm"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { Slug } from "../util/slug"
import { SessionV1 } from "../v1/session"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

/**
 * Fan-out: the parent never waits for its crew.
 *
 * Unlike a blocking subagent call this returns the moment the crew is recorded
 * and running. Whatever the parent would have blocked for is delivered later,
 * at a turn boundary, as a digest.
 *
 * This is deliberately NOT gated behind `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`.
 * That flag changes the blocking semantics of an existing tool, so it needs a
 * kill switch; `fanout` is a new tool an agent can only reach when it is
 * advertised, and a parent that never calls it cannot regress. The properties
 * that actually matter -- a durable ledger, hard breadth caps, a bounded
 * digest, push delivery -- are not experimental, and gating them would only
 * re-introduce the failure this exists to remove. The caps, not an env var,
 * are the blast-radius control.
 *
 * A Location node may not reach `SessionV2`: routing a session runs through
 * `LocationServiceMap`, whose type is the Location graph this node is part of.
 * So the child session is materialised from the parent's own durable row with
 * the same `session.created` event `SessionV2.create` publishes, and the child's
 * prompt is admitted straight into the input inbox. Nothing here is a second
 * implementation of session creation: it is one published event.
 */

export const name = "fanout"

export const Worker = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of this worker's task" }),
  prompt: Schema.String.annotate({ description: "The complete, self-contained task for this worker" }),
  agent: Schema.optional(Schema.String).annotate({
    description: "Specialized agent to run this worker as. Defaults to the session's own agent.",
  }),
})
export type Worker = typeof Worker.Type

export const Input = Schema.Struct({
  title: Schema.String.annotate({ description: "A short name for this batch of work" }),
  workers: Schema.Array(Worker).annotate({
    description: `Independent tasks to run concurrently. At most ${FanoutLimits.caps.maxWorkersPerGroup} per group.`,
  }),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  group: Fanout.GroupID,
  title: Schema.String,
  workers: Schema.Array(
    Schema.Struct({
      id: Fanout.WorkerID,
      description: Schema.String,
      session: SessionSchema.ID,
    }),
  ),
})
export type Output = typeof Output.Type

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const agents = yield* AgentV2.Service
    const permission = yield* PermissionV2.Service
    const background = yield* BackgroundJob.Service
    const runner = yield* SessionRunner.Service
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    /**
     * Runs one worker to completion off the parent's turn and records its digest.
     * Nothing here can fail the parent: it has already returned, and a worker's
     * failure still has to reach the ledger. Delivery is somebody else's job --
     * `FanoutDelivery` reacts to the settle event and pushes to the parent.
     */
    const supervise = (worker: FanoutLedger.Worker, run: Effect.Effect<void, unknown>) =>
      Effect.gen(function* () {
        const exit = yield* run.pipe(Effect.exit)
        const failure = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
        const digest = failure === undefined ? yield* FanoutDigest.ofSession(db, worker.sessionID) : undefined
        yield* FanoutLifecycle.settle(db, events, {
          workerID: worker.id,
          status: digest === undefined ? "error" : "done",
          ...(digest === undefined
            ? {
                error: FanoutDigest.failure(
                  failure === undefined ? "the worker produced no result" : describe(failure),
                ),
              }
            : { digest }),
        }).pipe(
          // The parent is already gone; losing its crew's record to a transient
          // failure here is the one unrecoverable outcome, so this is logged and
          // swallowed rather than left to kill an unobserved background fiber.
          Effect.catchCause((cause) =>
            Effect.logError("Fan-out result could not be recorded", cause).pipe(Effect.asVoid),
          ),
        )
        return worker.id
      })

    /**
     * Materialises one worker session as a child of the parent, in the parent's
     * project, so the whole crew shares one project, directory, and lineage.
     */
    const spawn = Effect.fn("FanoutTool.spawn")(function* (parent: typeof SessionTable.$inferSelect, worker: Worker) {
      const childID = SessionSchema.ID.create()
      const now = Date.now()
      const agent = yield* agents.select(worker.agent ?? parent.agent ?? undefined)
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
            agent: agent.id,
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
      // drain, so nothing can race it for a turn and nothing can interrupt the
      // parent mid-sentence to report in.
      yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID: childID,
        prompt: { text: worker.prompt },
        delivery: "queue",
      })
      return { childID }
    })

    yield* tools
      .register({
        [name]: Tool.make({
          description: [
            "Delegate independent work to a crew of background subagents and return immediately.",
            "Use this instead of a blocking subagent call whenever the tasks are independent: this call returns as soon as the crew is running and you keep talking to the user while it works.",
            `At most ${FanoutLimits.caps.maxGroups} groups may be live at once, with at most ${FanoutLimits.caps.maxWorkersPerGroup} workers per group.`,
            "Each worker reports a short digest automatically at your next turn. Do not sleep, poll, ask for status, or redo a worker's task.",
          ].join(" "),
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: FanoutLifecycle.summarise({ id: output.group, title: output.title }, output.workers),
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
                .pipe(Effect.mapError((error) => failure(error)))
              if (input.workers.length === 0) return yield* failure("A fan-out group needs at least one worker.")
              if (input.workers.length > FanoutLimits.caps.maxWorkersPerGroup)
                return yield* failure(
                  `A fan-out group holds at most ${FanoutLimits.caps.maxWorkersPerGroup} workers, got ${input.workers.length}. Split the work into another group instead.`,
                )
              const parent = yield* db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, context.sessionID))
                .get()
                .pipe(Effect.orDie)
              if (!parent) return yield* failure(`Session not found: ${context.sessionID}`)
              if (yield* FanoutLedger.findWorkerForSession(db, context.sessionID))
                return yield* failure(
                  "This session is itself a fan-out worker. Do not fan out from a worker; do the work directly.",
                )

              const available = yield* agents.all()
              const unknown = [
                ...new Set(
                  input.workers
                    .map((worker) => worker.agent)
                    .filter((agent): agent is string => agent !== undefined)
                    .filter((agent) => !available.some((entry) => entry.id === agent)),
                ),
              ]
              if (unknown.length > 0)
                return yield* failure(
                  `Unknown agent type: ${unknown.join(", ")}. Available: ${available.map((entry) => entry.id).join(", ")}`,
                )

              // A crew orphaned by an earlier process is settled from its own
              // durable record before new work competes for a cap slot.
              yield* reclaim(db, events, background, context.sessionID)

              const group = yield* FanoutLifecycle.open(db, events, {
                parentSessionID: context.sessionID,
                title: input.title,
              }).pipe(Effect.catchTag("Fanout.GroupLimitExceeded", (error) => failure(error.message)))

              const spawned = yield* Effect.forEach(input.workers, (worker) =>
                Effect.gen(function* () {
                  const child = yield* spawn(parent, worker)
                  const record = yield* FanoutLifecycle.join(db, events, {
                    groupID: group.id,
                    parentSessionID: context.sessionID,
                    sessionID: child.childID,
                    description: worker.description,
                  }).pipe(Effect.catchTag("Fanout.WorkerLimitExceeded", (error) => failure(error.message)))
                  yield* background.start({
                    id: child.childID,
                    type: name,
                    title: worker.description,
                    metadata: {
                      groupID: group.id,
                      workerID: record.id,
                      // Abort paths reach a job by `job.id`, `metadata.sessionId`
                      // and `metadata.parentSessionId` (Session.cancelBackgroundJobs,
                      // SessionRunState.cancelBackgroundJobs). A fan-out job's id is
                      // the worker's child Session, so the parent is only reachable
                      // through `parentSessionId` -- without it, aborting a parent
                      // left its whole crew running.
                      sessionId: child.childID,
                      parentSessionId: context.sessionID,
                    },
                    run: supervise(record, runner.run({ sessionID: child.childID, force: false })),
                  })
                  return { id: record.id, description: record.description, session: record.sessionID }
                }),
              )

              return { group: group.id, title: group.title, workers: spawned }
            }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : failure(error)))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

/**
 * Settles workers the ledger still calls live but that nothing is running any
 * more -- a restart, a closed location, a killed fiber -- from the child
 * session's own durable record, so a lost crew cannot hold a cap slot forever
 * or make the parent's cursor lie.
 */
export const reclaim = Effect.fn("FanoutTool.reclaim")(function* (
  db: Database.Interface["db"],
  events: EventV2.Interface,
  background: BackgroundJob.Interface,
  parentSessionID: SessionSchema.ID,
) {
  const running = new Set((yield* background.list()).map((job) => job.id))
  const stranded = (yield* FanoutLedger.live(db, parentSessionID)).filter((worker) => !running.has(worker.sessionID))
  for (const worker of stranded) {
    const digest = yield* FanoutDigest.ofSession(db, worker.sessionID)
    yield* FanoutLifecycle.settle(db, events, {
      workerID: worker.id,
      status: digest ? "done" : "error",
      ...(digest ? { digest } : { error: "the worker was interrupted before it produced a result" }),
    }).pipe(Effect.ignore)
  }
  return stranded.map((worker) => worker.id)
})

const failure = (error: unknown) =>
  error instanceof ToolFailure ? error : new ToolFailure({ message: describe(error) })
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const node = makeLocationNode({
  name: "tool/fanout",
  layer,
  deps: [
    ToolRegistry.node,
    PermissionV2.node,
    AgentV2.node,
    SessionProjector.node,
    SessionRunnerLLM.node,
    BackgroundJob.node,
    Database.node,
    EventV2.node,
  ],
})
