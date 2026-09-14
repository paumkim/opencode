import * as Tool from "./tool"
import DESCRIPTION from "./compact.txt"
import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import { type TaskPromptOps } from "./task"

const id = "compact"
export const Parameters = Schema.Struct({})

type Metadata = {}

/**
 * Agent-triggered session compaction.
 *
 * Lets an agent (or a `/compact` command) clear bloated, unwanted old
 * context from a long-running session without waiting for the user. It
 * enqueues a compaction marker on a new user message; the running prompt
 * loop auto-promotes it on the next iteration and runs the compaction
 * agent, which summarizes the history and clears old context.
 *
 * With `auto: true` the compaction agent also injects a continue message so
 * work resumes automatically afterwards. No `loop()` call is made here: the
 * tool executes inside the current turn's Runner, and re-entering it
 * synchronously would deadlock on the in-flight run's deferred. The marker
 * is picked up by the loop that is already running.
 *
 * The compaction enqueue is injected through `ctx.extra.promptOps.compact`
 * rather than pulled in as a registry dependency, mirroring `TaskTool`. This
 * keeps the tool registry's dependency surface free of the prompt/compaction
 * pipeline so it stays loadable in isolation (tests, code mode, etc.).
 *
 * The compaction agent inherits the parent's model: whatever model the
 * calling agent is using to talk to the parent is the model compaction runs
 * on, so the summary stays grounded in the same provider/capability.
 */
export const CompactTool = Tool.define(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!ops) throw new Error("Compaction is not available in this session")
          const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          const agent = session.agent ?? "build"
          yield* ops.compact({
            sessionID: session.id,
            agent,
            ...(session.model
              ? { model: { providerID: session.model.providerID, modelID: session.model.id } }
              : {}),
          })
          return {
            title: "Compacted session",
            metadata: {},
            output:
              "Session compaction scheduled. The conversation history is being summarized and old context cleared; continue from the retained summary.",
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)