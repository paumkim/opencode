export * as SessionPromptSize from "./prompt-size"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Token } from "@opencode-ai/core/util/token"
import type { DeepMutable } from "@opencode-ai/core/schema"
import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { ToolRegistry } from "@/tool/registry"
import { fromSchema } from "@/tool/json-schema"
import { ModelV2 } from "@opencode-ai/core/model"

/**
 * What the harness sends before the conversation even starts.
 *
 * `session timeline` measures the parts of a conversation and, when they do not
 * add up to the window, says the remainder is the system prompt and the tool
 * definitions. That is true and useless on its own: it names a size without ever
 * showing what is in it. This module shows it.
 *
 * The pieces are produced by the *real* builders — `SystemPrompt.Service` and
 * the tool registry — and joined by `SystemPrompt.assemble`, the same function
 * the request path uses. Nothing here re-implements the prompt, so a report
 * cannot describe a prompt that is not the one being sent.
 */

/** Where a piece of the prompt comes from, in the order it is sent. */
export const Piece = Schema.Literals([
  "agent",
  "provider",
  "environment",
  "instructions",
  "mcp",
  "skills",
  "crew",
  "system-one",
  "tools",
]).annotate({ identifier: "SessionPromptSizePiece" })
export type Piece = Schema.Schema.Type<typeof Piece>

export const Part = Schema.Struct({
  piece: Piece,
  /** Estimated tokens, or `null` for a piece this session will not send. */
  tokens: Schema.NullOr(Schema.Finite),
  /** One line saying what it is, for a report read rather than parsed. */
  detail: Schema.String,
  /** `false` for a piece that only exists during a turn, so it is never sent. */
  present: Schema.Boolean,
}).annotate({ identifier: "SessionPromptSizePart" })
export type Part = DeepMutable<Schema.Schema.Type<typeof Part>>

/** One tool definition as the provider receives it. */
export const Tool = Schema.Struct({
  name: Schema.String,
  tokens: Schema.Finite,
  /** Characters in the description, which is the part a user can actually cut. */
  description: Schema.Finite,
  /** Characters in the input schema, which is generated and not a prompt choice. */
  schema: Schema.Finite,
  /** Set when the tool is available but the agent is not permitted to call it. */
  denied: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "SessionPromptSizeTool" })
export type Tool = DeepMutable<Schema.Schema.Type<typeof Tool>>

export const Finding = Schema.Struct({
  id: Schema.String,
  severity: Schema.Literals(["warn", "info"]),
  title: Schema.String,
  detail: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
}).annotate({ identifier: "SessionPromptSizeFinding" })
export type Finding = DeepMutable<Schema.Schema.Type<typeof Finding>>

export const Report = Schema.Struct({
  agent: Schema.String,
  model: Schema.String,
  /** One entry per piece, in the order the prompt sends them. */
  parts: Schema.Array(Part),
  tools: Schema.Array(Tool),
  /** Estimated tokens for everything that is actually sent. */
  total: Schema.Finite,
  toolsTotal: Schema.Finite,
  findings: Schema.Array(Finding),
}).annotate({ identifier: "SessionPromptSizeReport" })
export type Report = DeepMutable<Schema.Schema.Type<typeof Report>>

// ---------------------------------------------------------------------------
// Analysis
//
// Pure functions over plain values, so the shape of a report can be reasoned
// about without assembling a real prompt.
// ---------------------------------------------------------------------------

/** A tool description above this is worth reading, whatever the total is. */
const TOOL_DESCRIPTION = 4_000
/** Tool definitions below this are not worth a share-based complaint. */
const TOOLS_WORTH_NAMING = 4_000
/** Above this share, one thing is the answer to "why is my prompt so big". */
const DOMINANT_SHARE = 0.4

export const EMPTY_PART: Part = { piece: "agent", tokens: null, detail: "", present: false }

const tokensOf = (text: string | undefined) => (typeof text === "string" ? Token.estimate(text) : null)

export function partsOf(input: {
  agent: string
  hasAgentPrompt: boolean
  /**
   * The agent's own prompt. This is the base prompt the request sends, in place
   * of the built-in one, so it is the text to measure: sizing the agent's *name*
   * would report an eleven-character name as the whole base prompt.
   */
  agentPrompt?: string
  providerPrompt?: string
  env?: string[]
  instructions?: string[]
  mcp?: string
  skills?: string
}): Part[] {
  const pieces: [Piece, string | string[] | undefined][] = [
    input.hasAgentPrompt ? ["agent", input.agentPrompt] : ["provider", input.providerPrompt],
    ["environment", input.env],
    ["instructions", input.instructions],
    ["mcp", input.mcp],
    ["skills", input.skills],
  ]
  return pieces.map(([piece, value]) => {
    const text = Array.isArray(value) ? value.join("\n") : value
    const present = typeof text === "string" && text.length > 0
    return {
      piece,
      tokens: tokensOf(text),
      detail:
        piece === "agent"
          ? "this agent's own prompt, replacing the built-in one"
          : piece === "provider"
            ? `the built-in prompt for ${input.agent}'s model`
            : piece === "environment"
              ? "where the agent is running"
              : piece === "instructions"
                ? "AGENTS.md and other project instruction files"
                : piece === "mcp"
                  ? "what connected MCP servers say about themselves"
                  : "the skill index the agent may load from",
      present,
    }
  })
}

/**
 * The two pieces that only exist during a turn.
 *
 * They are listed with `present: false` rather than omitted: a report that
 * silently left them out would read as though the prompt were complete, and
 * "delegation state" is something a user looking at a system prompt is entitled
 * to know exists.
 */
export const PER_TURN: Part[] = [
  {
    piece: "crew",
    tokens: null,
    detail: "which delegated subagents are still running, added per turn",
    present: false,
  },
  {
    piece: "system-one",
    tokens: null,
    detail: "the effort instruction from the local triage pre-filter, added per turn",
    present: false,
  },
]

export function totalOf(parts: readonly Part[]): number {
  return parts.reduce((total, part) => total + (part.tokens ?? 0), 0)
}

export function analyze(input: {
  parts: readonly Part[]
  tools: readonly Tool[]
  total: number
  toolsTotal: number
}): Finding[] {
  const findings: Finding[] = []
  const byPiece = (piece: Piece) => input.parts.find((part) => part.piece === piece)
  const base = byPiece(input.parts[0]?.piece === "agent" ? "agent" : "provider")
  const instructions = byPiece("instructions")
  const toolsPart = byPiece("tools")

  if (instructions?.present && base?.tokens && instructions.tokens && instructions.tokens > base.tokens) {
    findings.push({
      id: "prompt.instructions-dominate",
      severity: "info",
      title: `Your project instructions are ${formatTokens(instructions.tokens)} tokens, larger than the base prompt`,
      detail: `${formatTokens(instructions.tokens)} of instructions against ${formatTokens(base.tokens)} of ${base.piece === "agent" ? "agent prompt" : "built-in prompt"}.`,
      hint: "This is sent on every request, in every session, in this project. Trimming the instruction files is the cheapest context you will ever buy.",
    })
  }

  // A share alone is not worth reporting on a prompt that is small anyway: tools
  // being 40% of five hundred tokens is arithmetic, not a problem. The absolute
  // size is what a user can do something about, so it has to be met too.
  //
  // `total` already counts the tool definitions, because the tools row is one of
  // its parts. Dividing by `total + toolsTotal` counted them a second time, which
  // under-reported the share and moved the gate: tools that are 53% of what is
  // sent scored 35% and this stayed silent.
  const toolsShare = input.total > 0 ? input.toolsTotal / input.total : 0
  if (input.toolsTotal >= TOOLS_WORTH_NAMING && toolsShare >= DOMINANT_SHARE) {
    const worst = input.tools[0]
    findings.push({
      id: "prompt.tools-dominate",
      severity: "info",
      title: `Tool definitions are ${formatTokens(input.toolsTotal)} tokens, ${(toolsShare * 100).toFixed(0)}% of everything sent up front`,
      detail: worst ? `${worst.name} is the largest at ${formatTokens(worst.tokens)}.` : undefined,
      hint: "Tools are sent in full on every request whether or not a turn uses them; an agent with fewer tools sends less, always.",
    })
  }

  // A description long enough to read is a prompt choice someone made, and it is
  // paid for on every request, so it is worth naming even when the total is fine.
  for (const tool of input.tools) {
    if (tool.description >= TOOL_DESCRIPTION) {
      findings.push({
        id: `prompt.tool-description.${tool.name}`,
        severity: "info",
        title: `${tool.name}'s description is ${formatTokens(charsAsTokens(tool.description))} tokens`,
        detail: `Its input schema adds ${formatTokens(charsAsTokens(tool.schema))} more.`,
      })
      break
    }
  }

  if (toolsPart && !toolsPart.present && input.tools.length === 0) {
    findings.push({
      id: "prompt.no-tools",
      severity: "info",
      title: "No tool definitions were resolved for this agent",
      detail: "Either the agent has every tool disabled, or the registry could not be read.",
    })
  }

  if (input.total === 0) {
    findings.push({
      id: "prompt.empty",
      severity: "warn",
      title: "This prompt would be empty",
      detail: "Nothing resolved, so a request would carry no system prompt at all.",
    })
  }

  return findings
}

/**
 * Characters to tokens, using the same ratio the rest of the harness estimates
 * with. A tool's description is held as a length rather than as text, and
 * formatting a length as though it were a token count overstates it fourfold.
 */
export function charsAsTokens(chars: number): number {
  return Token.estimate("x".repeat(chars))
}

export function formatTokens(count: number | null): string {
  if (count === null) return "—"
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * The agent and model are passed in rather than looked up.
 *
 * Which agent is "the" one is a question about the caller, the same reasoning
 * `session usage` uses for "which session". Resolving it here would make the
 * service untestable against a hand-built agent, and would make `prompt show`
 * the only thing that could use it.
 */
export interface Input {
  readonly agent: Agent.Info
  readonly model: Provider.Model
}

export interface Interface {
  readonly report: (input: Input) => Effect.Effect<Report>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPromptSize") {}

/**
 * The size of a tool as the provider receives it.
 *
 * The wire form is `{ type, name, description, parameters }`, and `parameters` is
 * the tool's schema as `ToolJsonSchema.fromTool` produces it — the same
 * conversion `SessionTools` uses, so the size here is the size that goes out.
 * The description and the schema are kept apart because only the description is
 * something a user wrote and can shorten.
 */
export function measureTool(tool: {
  id: string
  description: string
  jsonSchema?: unknown
  parameters?: unknown
}): Tool {
  const schema = serialize(
    "jsonSchema" in tool && tool.jsonSchema !== undefined ? tool.jsonSchema : fromSchema(tool.parameters as never),
  )
  const description = tool.description ?? ""
  const wire = JSON.stringify({ type: "function", name: tool.id, description, parameters: schema })
  return {
    name: tool.id,
    tokens: Token.estimate(wire),
    description: description.length,
    schema: schema.length,
  }
}

function serialize(value: unknown): string {
  if (value === undefined) return "{}"
  try {
    return JSON.stringify(value) ?? "{}"
  } catch {
    // A tool whose schema will not serialize is still a tool the provider is
    // told about; an unknown size beats dropping it from the total.
    return "{}"
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const system = yield* SystemPrompt.Service
    const registry = yield* ToolRegistry.Service
    const instruction = yield* Instruction.Service

    const report: Interface["report"] = Effect.fn("SessionPromptSize.report")(function* (input: Input) {
      const { agent, model } = input
      // The same builders and the same assembly the request path uses. This is
      // the whole point: a report that rebuilt the prompt would drift.
      const env = yield* system.environment(model)
      const instructions = yield* instruction.system().pipe(Effect.orDie)
      const mcp = yield* system.mcp(agent)
      const skills = yield* system.skills(agent)
      const pieces = partsOf({
        agent: agent.name,
        hasAgentPrompt: typeof agent.prompt === "string" && agent.prompt.length > 0,
        agentPrompt: agent.prompt,
        providerPrompt: SystemPrompt.provider(model)[0],
        env,
        instructions,
        mcp,
        skills,
      })
      const tools = (yield* registry.tools({
        providerID: model.providerID,
        modelID: ModelV2.ID.make(model.api.id),
        agent,
      }))
        .map((tool) => measureTool(tool))
        .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
      const parts = [...pieces, ...PER_TURN, toolsPart(tools)]
      const total = totalOf(parts)
      const toolsTotal = tools.reduce((sum, tool) => sum + tool.tokens, 0)
      return {
        agent: agent.name,
        model: `${model.providerID}/${model.api.id}`,
        parts,
        tools,
        total,
        toolsTotal,
        findings: analyze({ parts, tools, total, toolsTotal }),
      }
    })

    return Service.of({ report })
  }),
)

function toolsPart(tools: readonly Tool[]): Part {
  const total = tools.reduce((sum, tool) => sum + tool.tokens, 0)
  return {
    piece: "tools",
    tokens: tools.length === 0 ? null : total,
    detail: `${tools.length} tool definition${tools.length === 1 ? "" : "s"}, sent whether or not a turn uses them`,
    present: tools.length > 0,
  }
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [SystemPrompt.node, ToolRegistry.node, Instruction.node],
})
