import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Agent } from "../agent/agent"

const AGENTS_DESCRIPTION =
  "List available agents and their types. Use this to discover which subagent types can be used with the task tool for delegation."

export const Parameters = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["primary", "subagent", "all"])).annotate({
    description:
      "Filter agents by mode. 'primary' = main agents, 'subagent' = delegate-only agents, 'all' = everything (default).",
  }),
})

type Metadata = {
  agents: ReadonlyArray<{ name: string; mode: string; description: string }>
}

export const AgentsTool = Tool.define<typeof Parameters, Metadata, Agent.Service>(
  "agents",
  Effect.gen(function* () {
    const agents = yield* Agent.Service

    return {
      description: AGENTS_DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const all = yield* agents.list()
          const filtered = params.mode
            ? all.filter((a) => a.mode === params.mode || params.mode === "all")
            : all.filter((a) => !a.hidden)

          const sorted = filtered.toSorted((a, b) => a.name.localeCompare(b.name))

          const lines = sorted.map((a) => {
            const mode = a.mode === "subagent" ? "subagent" : a.mode === "primary" ? "primary" : "all"
            const desc = a.description ?? ""
            return `- ${a.name} (${mode}): ${desc}`
          })

          const summary = `Available agents (${sorted.length}):`
          const output = [summary, ...lines].join("\n")

          return {
            title: `Listed ${sorted.length} agent(s)`,
            output,
            metadata: {
              agents: sorted.map((a) => ({
                name: a.name,
                mode: a.mode,
                description: a.description ?? "",
              })),
            },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

export * as Agents from "./agents"
