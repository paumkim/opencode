import { Effect, Schema } from "effect"
import { z } from "zod"
import {
  clearGoal,
  canRecordCompletion,
  completeGoal,
  createGoal,
  escapePromptText,
  extendGoal,
  formatGoalHistory,
  getGoal,
  markGoalUnmet,
  recordGoalCompletion,
  setGoalStatus,
  updateGoalObjective,
} from "@/goal/impl"
import { Agent } from "@/agent/agent"
import { errorMessage } from "@/util/error"
import * as Tool from "@/tool/tool"
import * as Truncate from "@/tool/truncate"
import { zodArgs } from "@/tool/zod"
import {
  resolveCreateGoalLimits,
  restrictedAgentSet,
  tokensFromMessages,
  type Client,
  type CreateGoalArgs,
  type ExtendGoalArgs,
  type Options,
  type UpdateGoalArgs,
} from "@/goal/shared"
import {
  GOAL_DEFAULT_MAX_AUTO_TURNS,
  GOAL_MAX_EVIDENCE,
  GOAL_MAX_OBJECTIVE,
  positiveIntegerOrNull,
  withinCharacterLimit,
} from "@/goal/schema"

// 0 means unbounded: goals are never capped at a default number of auto-continues.
// An explicit positive `max_auto_turns` config value still wins (see positiveIntegerOrNull).
// The value itself lives in schema.ts as GOAL_DEFAULT_MAX_AUTO_TURNS, which documents itself as
// the single source of truth for it; defining it here too meant editing it had no effect here.
// Shared messages so the tool boundary and `validateObjective`/`validateEvidence` describe the same
// limit identically. `.max(n)` produced a zod-specific message and counted UTF-16 code units, so an
// objective of n emoji was rejected here with a different error than the implementation's.
const objectiveLimitMessage = `objective must be at most ${GOAL_MAX_OBJECTIVE} characters`
const evidenceLimitMessage = `must be at most ${GOAL_MAX_EVIDENCE} characters`

/**
 * The limit args every goal-creating tool shares. Exported so a test can assert that the argument
 * contract the `/goal` prompt documents is actually accepted here: the prompt tells the model to
 * pass `null` for every limit the user did not name, and nothing else checks that the tool agrees.
 * A tool-naming test cannot catch a schema that stopped accepting one of these.
 */
export const goalLimitArgs = {
  token_budget: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("Optional positive token budget. Omit or pass null for unlimited."),
  max_auto_turns: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("Optional per-goal auto-continue limit. Omit or pass null for unlimited."),
  max_duration_seconds: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("Optional per-goal duration limit. Omit or pass null for unlimited."),
  no_progress_token_threshold: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      "Optional per-goal minimum output tokens for a continuation turn to count as progress; a turn producing fewer is counted as a stall. LOWER it to tolerate turns that are quiet but real (a long build or test run), because raising it makes more turns count as low-progress and pauses the goal sooner.",
    ),
  max_no_progress_turns: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      "Optional consecutive low-progress turns tolerated before auto-pausing. Raise for unattended/overnight runs; the default (2) pauses quickly.",
    ),
  max_prompt_failures: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      "Optional consecutive failed auto-continue prompts tolerated before auto-pausing. Raise for unattended runs so transient provider/network failures do not stop the goal.",
    ),
}

/** The objective arg, shared by create_goal/set_goal/update_goal. Exported so the test can assert the
 * real boundary rather than a reconstruction of it. */
export const goalObjectiveArg = z
  .string()
  .min(1)
  .refine((value) => withinCharacterLimit(value, GOAL_MAX_OBJECTIVE), { message: objectiveLimitMessage })

/** The evidence/blocker arg, shared by update_goal. */
export const goalEvidenceArg = z
  .string()
  .min(1)
  .refine((value) => withinCharacterLimit(value, GOAL_MAX_EVIDENCE), { message: evidenceLimitMessage })

/**
 * The optional short-label arg, shared by create_goal/set_goal/update_goal_objective. Exported so a
 * test can assert the real boundary rather than a reconstruction of it.
 *
 * No `.max(...)` on purpose: an over-long title is TRUNCATED by `validateTitle`, not rejected. The
 * objective is the goal's durable record and is worth refusing, but a title only ever appears in a
 * one-line bar that truncates anyway - so a schema-level refusal here would fail goal creation over
 * a cosmetic field, and the tool boundary would then disagree with the implementation on purpose.
 */
export const goalTitleArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Optional SHORT one-line label for the session status bar, a few words and not a sentence. This is what the bar shows instead of the objective, which carries the outcome and anything a later turn could not cheaply re-derive. Omit it if you have no better short label; the objective is then used as before.",
  )

const PLAN_MODE_CREATE_NOTICE =
  'Goal recorded while the session is in Plan mode, so execution is paused. Do not start implementation work now. Ask the user to switch to Build mode and resume the goal (for example with "/goal resume") to begin execution.'

export interface Deps {
  client: Client
  options: Options
  agent: Agent.Interface
  truncate: Truncate.Interface
}

type Execute = (args: any, ctx: Tool.Context) => Promise<string>

/**
 * Builds a core tool from a Zod-arg plugin-style definition, reproducing the semantics the tool
 * registry applied to plugin tools: Zod validation for the arguments, the generated JSON Schema
 * for the model, `truncate.output` on the result, and the same `Tool.execute` span.
 */
function defineTool(
  id: string,
  description: string,
  args: Record<string, z.ZodType>,
  deps: Deps,
  execute: Execute,
): Tool.Def<Schema.Decoder<unknown>> {
  const { parameters, jsonSchema } = zodArgs(args)
  return {
    id,
    description,
    parameters,
    jsonSchema,
    execute: (toolArgs, toolCtx) =>
      Effect.gen(function* () {
        const output = yield* Effect.promise(() => execute(toolArgs, toolCtx))
        const info = yield* deps.agent.get(toolCtx.agent)
        const truncated = yield* deps.truncate.output(output, {}, info)
        return {
          title: "",
          output: truncated.truncated ? truncated.content : output,
          metadata: {
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          },
        }
      }).pipe(
        Effect.withSpan("Tool.execute", {
          attributes: {
            "tool.name": id,
            "session.id": toolCtx.sessionID,
            "message.id": toolCtx.messageID,
            ...(toolCtx.callID ? { "tool.call_id": toolCtx.callID } : {}),
          },
        }),
      ),
  }
}

export function goalTools(deps: Deps): Record<string, Tool.Def<Schema.Decoder<unknown>>> {
  const options = deps.options
  const maxAutoTurns = positiveIntegerOrNull(options.max_auto_turns) ?? GOAL_DEFAULT_MAX_AUTO_TURNS
  const isPlanAgent = (agent: unknown) => {
    const names = restrictedAgentSet(options)
    return typeof agent === "string" && names.has(agent.trim().toLowerCase())
  }

  async function createGoalFromTool(input: CreateGoalArgs, ctx: { sessionID: string; agent?: string }) {
    const planningOnly = isPlanAgent(ctx.agent)
    const sessionTokensAtCreation = await fetchSessionTokens(deps.client, ctx.sessionID, (message) =>
      console.error(message),
    )
    const goal = await createGoal(ctx.sessionID, input.objective, {
      ...resolveCreateGoalLimits(input, options),
      title: input.title ?? null,
      // A per-call value wins over the config default. The defaults are tuned for interactive
      // use and self-pause an unattended run quickly, so a caller that asks for a tolerant goal
      // must not be silently downgraded to them.
      noProgressTokenThreshold: input.no_progress_token_threshold ?? options.no_progress_token_threshold ?? null,
      maxNoProgressTurns: input.max_no_progress_turns ?? options.max_no_progress_turns ?? null,
      maxPromptFailures: input.max_prompt_failures ?? null,
      agent: typeof ctx.agent === "string" ? ctx.agent : null,
      initialStatus: planningOnly ? "paused" : "active",
      sessionTokensAtCreation,
    })
    return JSON.stringify(planningOnly ? { goal, plan_mode_notice: PLAN_MODE_CREATE_NOTICE } : { goal }, null, 2)
  }

  const limitArgs = goalLimitArgs

  return {
    get_goal: defineTool(
      "get_goal",
      "Get the current goal for this OpenCode session, including status, observed token usage, elapsed-time usage, budgets, completed work, checkpoints, and history.",
      {},
      deps,
      async (_args, context) => JSON.stringify({ goal: await getGoal(context.sessionID) }, null, 2),
    ),
    get_goal_history: defineTool(
      "get_goal_history",
      "Get the current goal lifecycle history and recent checkpoints for this OpenCode session.",
      {},
      deps,
      async (_args, context) => {
        const goal = await getGoal(context.sessionID)
        return JSON.stringify({ goal, history_report: formatGoalHistory(goal) }, null, 2)
      },
    ),
    record_goal_completion: defineTool(
      "record_goal_completion",
      "Record one unit of work as finished on the session goal. Call this as soon as a bounded deliverable is done AND verified, with a short description of what is now true. The completed list is written into every continuation prompt, so it is how the next turn knows what is already done and can move forward instead of redoing it. Re-recording an item that is already listed is a no-op. Recording nothing across a tool-heavy turn counts as no progress and will pause the goal, so a long run must record each finished unit. A goal that has hit a safety limit still accepts records - it is not finished, and its ledger is what the resumed run reads first - so record what you completed during the wrap-up turn too. A paused or closed goal does not accept them.",
      {
        item: z.string().min(1).describe("Short description of the finished work, as a statement of what is now true."),
      },
      deps,
      async (args, context) => {
        const goal = await recordGoalCompletion(context.sessionID, args.item)
        if (!goal) return "No active goal for this session; nothing was recorded."
        // A snapshot is returned for a goal in ANY status, but only a goal that can still accept a
        // record has one recorded onto. Testing only for `!goal` therefore reported a discarded
        // record as a success-shaped `{goal}` payload: the model was told to call this the moment a
        // unit is done, believed it had closed the unit out, and the next turn's ledger did not list
        // it - so the work was redone. That is the loop the ledger exists to prevent, and this is
        // what made it invisible. The predicate is `canRecordCompletion` itself rather than a second
        // spelling of it, so this report and `recordGoalCompletion` cannot disagree.
        if (!canRecordCompletion(goal.status))
          return `The goal for this session is ${goal.status}, and a ${goal.status} goal does not accept completed-work records, so nothing was recorded. Its completed list still reads ${
            goal.completed.length === 0 ? "empty" : `${goal.completed.length} item(s)`
          }.`
        return JSON.stringify({ goal }, null, 2)
      },
    ),
    create_goal: defineTool(
      "create_goal",
      "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Fails while a goal is still open (active, paused, budgetLimited, or usageLimited); a goal that is complete or unmet does not block a new one, so do not try to close or clear it first. Limits are unlimited by default: omitting a limit arg (or passing null) means no token budget, no auto-continue cap, and no duration cap, so only pass numbers the user explicitly asked for. While the session is in Plan mode, the goal is recorded as paused and execution requires the user to switch to Build mode. The objective is the durable record: the outcome to reach, plus anything a later turn could not cheaply re-derive from the repo, and not the backlog. `title` is the short one-line label the status bar shows, so pass a few words whenever you can.",
      {
        objective: goalObjectiveArg.describe("The concrete objective to start pursuing."),
        title: goalTitleArg,
        ...limitArgs,
      },
      deps,
      async (args, context) => createGoalFromTool(args as CreateGoalArgs, context),
    ),
    set_goal: defineTool(
      "set_goal",
      "Set a new goal when the user explicitly asks the AGENT to formulate and set its own goal (the model writes the objective itself). Prefer create_goal when passing the user's own words. Fails while a goal is still open (active, paused, budgetLimited, or usageLimited); a goal that is complete or unmet does not block a new one, so do not try to close or clear it first. Limits are unlimited by default: omitting a limit arg (or passing null) means no token budget, no auto-continue cap, and no duration cap, so only pass numbers the user explicitly asked for. While the session is in Plan mode, the goal is recorded as paused and execution requires the user to switch to Build mode. The objective is the durable record: the outcome to reach, plus anything a later turn could not cheaply re-derive from the repo, and not the backlog. `title` is the short one-line label the status bar shows, so pass a few words whenever you can.",
      {
        objective: goalObjectiveArg.describe("The model-formulated concrete objective to start pursuing."),
        title: goalTitleArg,
        ...limitArgs,
      },
      deps,
      async (args, context) => createGoalFromTool(args as CreateGoalArgs, context),
    ),
    update_goal_objective: defineTool(
      "update_goal_objective",
      "Edit the current OpenCode goal objective when the user explicitly asks to edit or replace it. The objective is the durable record: the outcome to reach, plus anything a later turn could not cheaply re-derive from the repo, and not the backlog. `title` is the short one-line label the status bar shows, so pass a few words whenever you can.",
      {
        objective: goalObjectiveArg.describe("The updated concrete objective."),
        title: goalTitleArg,
        status: z.enum(["active", "paused"]).optional().describe("Whether the edited goal should be active or paused."),
      },
      deps,
      async (args, context) => {
        const input = args as { objective: string; title?: string; status?: "active" | "paused" }
        const requested = input.status ?? "active"
        const planningOnly = requested === "active" && isPlanAgent(context.agent)
        const goal = await updateGoalObjective(
          context.sessionID,
          input.objective,
          planningOnly ? "paused" : requested,
          {
            agent: typeof context.agent === "string" ? context.agent : null,
            planModePause: planningOnly,
            // Editing the objective resumes, so this path needs the same configured turn default the
            // resume guard and runtime enforcement share.
            defaultMaxAutoTurns: maxAutoTurns,
            // Omitted (undefined) keeps the existing label; only a title the model actually sends
            // replaces it, so an ordinary objective edit cannot drop the bar's label.
            title: input.title,
          },
        )
        return JSON.stringify(planningOnly ? { goal, plan_mode_notice: PLAN_MODE_CREATE_NOTICE } : { goal }, null, 2)
      },
    ),
    update_goal: defineTool(
      "update_goal",
      "Close the existing goal only after an audit against real evidence. Use status complete only when the objective is achieved and no required work remains, and include evidence. Use status unmet only when the objective cannot be achieved or is blocked, and include the blocker. Do not close a goal merely because work is stopping.",
      {
        status: z
          .enum(["complete", "unmet"])
          .describe("Required. complete means achieved; unmet means blocked or impossible."),
        evidence: goalEvidenceArg
          .optional()
          .describe("Required when status is complete. Summarize the concrete evidence verified."),
        blocker: goalEvidenceArg
          .optional()
          .describe("Required when status is unmet. Explain the concrete blocker or impossibility."),
      },
      deps,
      async (args, context) => {
        const input = args as UpdateGoalArgs
        // The report is prose the model reads, and it quotes the evidence or blocker verbatim, so
        // it gets the same escaping `formatGoal` and `formatGoalHistory` apply. The structured
        // `goal` next to it stays raw: that is data, and escaping inside JSON would corrupt it.
        if (input.status === "complete") {
          const goal = await completeGoal(context.sessionID, input.evidence ?? "")
          const budget = goal.tokenBudget == null ? "" : ` Token usage: ${goal.tokensUsed}/${goal.tokenBudget}.`
          const report = `Goal achieved. Time used: ${goal.timeUsedSeconds} seconds.${budget} Evidence: ${escapePromptText(goal.completionEvidence ?? "")}.`
          return JSON.stringify({ goal, completion_report: report }, null, 2)
        }
        const goal = await markGoalUnmet(context.sessionID, input.blocker ?? "")
        const report = `Goal unmet. Time used: ${goal.timeUsedSeconds} seconds. Blocker: ${escapePromptText(goal.blocker ?? "")}.`
        return JSON.stringify({ goal, unmet_report: report }, null, 2)
      },
    ),
    extend_goal: defineTool(
      "extend_goal",
      "Explicitly extend the budgets of a goal that stopped at a token, turn, or duration limit. Requires at least one limit to be named - a higher number, or null for no cap at all - on ANY of the three, so a limit the user did not name can be lifted as well as raised; preserves usage and history. Closed and ordinary active goals are rejected.",
      {
        token_budget: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe("Higher token budget, or null for no token limit."),
        max_auto_turns: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe("Higher auto-continue limit, or null for no auto-continue limit."),
        max_duration_seconds: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe("Higher duration limit, or null for no duration limit."),
      },
      deps,
      async (args, context) => {
        if (isPlanAgent(context.agent)) {
          throw new Error(
            "cannot extend or reactivate the goal while the session is in Plan mode; switch to Build mode first",
          )
        }
        const input = args as ExtendGoalArgs
        // Pass the SAME configured turn default that runtime enforcement uses, so extension
        // reactivation eligibility can never disagree with enforcement.
        const goal = await extendGoal(
          context.sessionID,
          {
            tokenBudget: input.token_budget,
            maxAutoTurns: input.max_auto_turns,
            maxDurationSeconds: input.max_duration_seconds,
          },
          maxAutoTurns,
        )
        return JSON.stringify({ goal }, null, 2)
      },
    ),
    update_goal_status: defineTool(
      "update_goal_status",
      "Pause or resume the current OpenCode goal when the user explicitly asks to pause or resume it. Resuming is not allowed while the session is in Plan mode; the user must switch to Build mode first.",
      {
        status: z.enum(["active", "paused"]).describe("active resumes a goal; paused pauses it without clearing it."),
      },
      deps,
      async (args, context) => {
        const input = args as { status: "active" | "paused" }
        if (input.status === "active" && isPlanAgent(context.agent)) {
          throw new Error(
            "cannot resume the goal while the session is in Plan mode; ask the user to switch to Build mode and resume the goal from there",
          )
        }
        const goal = await setGoalStatus(
          context.sessionID,
          input.status,
          typeof context.agent === "string" ? context.agent : null,
          // Same reason as `extend_goal` above: the resume guard must resolve the cap the runtime
          // actually enforces, or it re-admits a goal whose turn allowance is already spent.
          maxAutoTurns,
        )
        return JSON.stringify({ goal }, null, 2)
      },
    ),
    clear_goal: defineTool(
      "clear_goal",
      "Clear the current OpenCode goal for this session when the user explicitly asks to clear it.",
      {},
      deps,
      async (_args, context) => JSON.stringify({ cleared: await clearGoal(context.sessionID) }, null, 2),
    ),
  }
}

/**
 * Reads the session's cumulative token usage to anchor a new goal's `sessionTokensAtCreation`.
 *
 * Returns `null` when the usage could not be established, which is deliberately NOT the same as 0.
 * `accountUsage` differences every later observation against that baseline, and `impl.ts` only
 * re-anchors when the baseline is absent:
 *
 * - `null` -> `sessionTokensAtCreation` is never written, `accountUsage` takes the
 *   `goal.sessionTokensAtCreation == null` branch and anchors a fresh zero-usage cursor. The goal
 *   starts accounting from the first real observation.
 * - `0` -> the baseline is a *real* number, so it is persisted and `lastSessionTokens != null` holds.
 *   The very next observation charges `cumulative - 0`, i.e. the whole pre-existing session history
 *   as usage the goal spent. `nonNegativeIntegerOrUndefined` keeps 0 (it is a valid non-negative
 *   integer), so nothing later corrects it.
 *
 * So a failed read that resolved to 0 charged the goal for every token the session had ever used,
 * which can immediately trip `tokenBudget` and `noProgressTokenThreshold` and pause a goal that
 * has spent nothing. That is why the original `.catch(() => null)` was not enough: the SDK resolves
 * a non-2xx as a result tuple carrying `error` rather than rejecting, so the catch never ran for an
 * HTTP failure and the `error` check below is what actually separates the two states.
 *
 * An empty message list from a *successful* read is 0 and stays 0: a genuinely empty session has
 * genuinely used no tokens, and that is a real answer rather than a missing measurement.
 *
 * Exported for the test that pins the null/0 distinction, which is invisible from the value alone
 * in every other respect.
 */
export async function fetchSessionTokens(client: Client, sessionID: string, report: (message: string) => void) {
  const result = await client.session.messages({ path: { id: sessionID } })
  const failure = (result as { error?: unknown } | undefined)?.error
  if (failure) {
    report(`[goal] failed to read session usage for goal creation: ${errorMessage(failure)}`)
    return null
  }
  const data = Array.isArray(result.data) ? result.data : []
  return tokensFromMessages(data as { info?: unknown; parts?: unknown[] }[])
}
