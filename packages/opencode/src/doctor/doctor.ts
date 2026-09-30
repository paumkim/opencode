export * as Doctor from "./doctor"

import { Schema } from "effect"
import type { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import type { DeepMutable } from "@opencode-ai/core/schema"

// ---------------------------------------------------------------------------
// Report model
// ---------------------------------------------------------------------------

/**
 * `error` is reserved for state that is broken, not merely surprising: an agent
 * pinned to a model that does not exist, an MCP server that failed to start.
 * `warn` covers configuration that is accepted and then silently ignored —
 * a misspelled permission key, a `grep` that has to fall back. `ok` is only
 * emitted for a check that found nothing wrong, so every section of the report
 * is represented even on a healthy machine.
 */
export const Severity = Schema.Literals(["error", "warn", "info", "ok"]).annotate({
  identifier: "DoctorSeverity",
})
export type Severity = Schema.Schema.Type<typeof Severity>

export const Finding = Schema.Struct({
  /** Stable machine identifier, e.g. `agent.model.unknown`. */
  id: Schema.String,
  severity: Severity,
  title: Schema.String,
  detail: Schema.optional(Schema.String),
  /** Actionable next step, rendered under the finding. */
  hint: Schema.optional(Schema.String),
}).annotate({ identifier: "DoctorFinding" })
export type Finding = DeepMutable<Schema.Schema.Type<typeof Finding>>

export const Report = Schema.Struct({
  findings: Schema.Array(Finding),
}).annotate({ identifier: "DoctorReport" })
export type Report = DeepMutable<Schema.Schema.Type<typeof Report>>

const ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2, ok: 3 }

export const finding = (
  severity: Severity,
  id: string,
  title: string,
  extra?: { detail?: string; hint?: string },
): Finding => ({ id, severity, title, ...extra })

export const sort = (findings: readonly Finding[]): Finding[] =>
  [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.id.localeCompare(b.id))

export const summarize = (findings: readonly Finding[]): Record<Severity, number> => {
  const counts: Record<Severity, number> = { error: 0, warn: 0, info: 0, ok: 0 }
  for (const item of findings) counts[item.severity] += 1
  return counts
}

/** Non-zero only when something is actually broken — a warning is not a failure. */
export const exitCode = (findings: readonly Finding[]): 0 | 1 =>
  findings.some((item) => item.severity === "error") ? 1 : 0

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/** Two-row Levenshtein. Inputs here are identifiers, so the O(n*m) table is fine. */
export function distance(a: string, b: string): number {
  if (a === b) return 0
  const lower = a.toLowerCase()
  const upper = b.toLowerCase()
  if (lower === upper) return 0
  let previous = Array.from({ length: upper.length + 1 }, (_, i) => i)
  for (let i = 1; i <= lower.length; i++) {
    const current = [i]
    for (let j = 1; j <= upper.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (lower[i - 1] === upper[j - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[upper.length]
}

/**
 * Closest identifiers to `query`, best first. The distance ceiling scales with
 * the query length so a one-character typo in a long model id still matches
 * while an unrelated short query does not drag in the whole catalog.
 */
export function suggest(query: string, candidates: Iterable<string>, limit = 3): string[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const max = Math.max(2, Math.ceil(needle.length / 3))
  return [...candidates]
    .map((candidate) => {
      const lower = candidate.toLowerCase()
      // An exact substring is a better signal than a small edit distance: a user
      // who wrote "gpt5" wants "gpt-5", not "gpt-4o".
      if (lower === needle) return { candidate, score: 0 }
      if (lower.includes(needle)) return { candidate, score: 1 }
      const edits = distance(needle, lower)
      return { candidate, score: edits <= max ? edits + 1 : Number.POSITIVE_INFINITY }
    })
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((item) => item.candidate)
}

const didYouMean = (items: readonly string[]) => (items.length > 0 ? `Did you mean: ${items.join(", ")}?` : undefined)

// ---------------------------------------------------------------------------
// Known key sets
// ---------------------------------------------------------------------------

/**
 * Permission names the runtime can actually match.
 *
 * The first group is what `ConfigPermissionV1.InputObject` names explicitly in
 * `packages/core/src/v1/config/permission.ts`. The second is the plan-mode
 * pseudo-tools, which the harness itself uses as permission names
 * (`src/agent/agent.ts`, `src/cli/cmd/run.ts`) even though they are not schema
 * fields. Both are needed: a key on neither list is absorbed by the
 * `StructWithRest` catch-all and can never match.
 */
export const PERMISSION_KEYS = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "lsp",
  "doom_loop",
  "skill",
  "plan_enter",
  "plan_exit",
] as const

/** A permission name containing `*` or `?` is a pattern, not a literal. */
const isPattern = (key: string) => /[*?]/.test(key)

/**
 * Agent config fields that `Agent` actually copies onto the runtime agent
 * (`src/agent/agent.ts`). `frequency_penalty` and `presence_penalty` are
 * deliberately absent: the config schema accepts them and no code path reads
 * them, so they are reported rather than treated as known.
 */
export const AGENT_KEYS = [
  "model",
  "variant",
  "temperature",
  "top_p",
  "prompt",
  "context",
  "description",
  "mode",
  "hidden",
  "color",
  "steps",
  "options",
  "permission",
  "disable",
] as const

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ModelCatalog {
  /** Known model ids, keyed by provider id. */
  readonly providers: Readonly<Record<string, readonly string[]>>
  /** Ids from `disabled_providers`; configured but deliberately switched off. */
  readonly disabled?: ReadonlySet<string>
}

export interface ModelRef {
  readonly providerID: string
  readonly modelID: string
}

/**
 * Splits a configured `"provider/model"` string. `Provider.parseModel` accepts
 * anything — a bare id parses as a provider with an empty model and a three-part
 * id glues the tail together — so a doctor check has to reject the shapes the
 * parser would silently accept.
 */
export function parseModelReference(raw: string): ModelRef | undefined {
  const index = raw.indexOf("/")
  if (index <= 0 || index === raw.length - 1) return undefined
  return { providerID: raw.slice(0, index), modelID: raw.slice(index + 1) }
}

export function checkModel(input: { raw: string; catalog: ModelCatalog; subject: string }): Finding[] {
  const ref = parseModelReference(input.raw)
  if (!ref) {
    return [
      finding("error", "model.malformed", `${input.subject} uses the malformed model "${input.raw}"`, {
        detail: "Models are written as provider/model, for example anthropic/claude-sonnet-4-5.",
      }),
    ]
  }
  const models = input.catalog.providers[ref.providerID]
  if (!models) {
    return [
      finding("error", "model.provider-unknown", `${input.subject} uses the unknown provider "${ref.providerID}"`, {
        detail: `No provider named "${ref.providerID}" is known.`,
        hint: didYouMean(suggest(ref.providerID, Object.keys(input.catalog.providers), 5)),
      }),
    ]
  }
  if (models.includes(ref.modelID)) {
    if (input.catalog.disabled?.has(ref.providerID)) {
      return [
        finding("warn", "model.provider-disabled", `${input.subject} uses the disabled provider "${ref.providerID}"`, {
          detail: "The model exists but disabled_providers switches the provider off, so requests to it fail.",
        }),
      ]
    }
    return []
  }
  return [
    finding("error", "model.unknown", `${input.subject} uses the unknown model "${input.raw}"`, {
      detail: `Provider "${ref.providerID}" has no model "${ref.modelID}".`,
      hint: didYouMean(suggest(ref.modelID, models, 5)),
    }),
  ]
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentCheckInput {
  /** Agent config exactly as `Config` decoded it (unknown keys land in `options`). */
  readonly config: ConfigAgentV1.Info
  /**
   * Every tool id and permission key the running instance would accept. Sourced
   * from the tool registry plus {@link PERMISSION_KEYS}, so a plugin-provided
   * tool counts as known without this module tracking plugin ids.
   */
  readonly knownKeys: ReadonlySet<string>
  readonly catalog: ModelCatalog
  /** `default_agent` from config, when set. */
  readonly defaultAgent?: string
  /** Resolved mode of `defaultAgent`; undefined when no such agent exists. */
  readonly defaultAgentMode?: string
  readonly defaultAgentHidden?: boolean
}

function checkAgentKeys(name: string, config: ConfigAgentV1.Info, knownKeys: ReadonlySet<string>): Finding[] {
  const findings: Finding[] = []
  const where = `Agent "${name}"`

  if (config.maxSteps !== undefined) {
    findings.push(
      finding("warn", "agent.maxSteps.deprecated", `${where} sets "maxSteps", which is deprecated`, {
        hint: 'Use "steps" instead; "maxSteps" is only read when "steps" is absent.',
      }),
    )
    if (config.steps !== undefined && config.steps !== config.maxSteps) {
      findings.push(
        finding("warn", "agent.steps.conflict", `${where} sets "steps" and "maxSteps" to different values`, {
          detail: `steps=${config.steps} wins, maxSteps=${config.maxSteps} is ignored.`,
        }),
      )
    }
  }

  if (config.tools !== undefined) {
    findings.push(
      finding("warn", "agent.tools.deprecated", `${where} uses the deprecated "tools" field`, {
        hint: 'Use "permission" instead, e.g. { "permission": { "bash": "allow" } }.',
      }),
    )
  }

  if (config.frequency_penalty !== undefined) {
    findings.push(
      finding("warn", "agent.frequency_penalty.ignored", `${where} sets "frequency_penalty", which is never applied`, {
        detail: "The config schema accepts the field but no code path forwards it to the provider.",
      }),
    )
  }

  if (config.presence_penalty !== undefined) {
    findings.push(
      finding("warn", "agent.presence_penalty.ignored", `${where} sets "presence_penalty", which is never applied`, {
        detail: "The config schema accepts the field but no code path forwards it to the provider.",
      }),
    )
  }

  // Permission names split three ways: a name the runtime knows, a pattern
  // (`*_*` is the idiom for "any MCP tool"), and everything else. Only the last
  // group is reported, and a near miss of a known name is a far stronger signal
  // than an unfamiliar one — an unfamiliar name is usually an MCP or plugin
  // tool, which cannot be enumerated without connecting to the server.
  const typos: { key: string; near: string[] }[] = []
  const unfamiliar: string[] = []
  for (const key of Object.keys(config.permission ?? {})) {
    if (knownKeys.has(key) || isPattern(key)) continue
    const near = suggest(key, knownKeys, 2)
    if (near.length > 0) typos.push({ key, near })
    else unfamiliar.push(key)
  }

  for (const { key, near } of typos) {
    findings.push(
      finding("warn", "agent.permission.typo", `${where} sets "${key}", which looks like a typo of "${near[0]}"`, {
        detail: "No tool or permission is named that, so the rule can never match and the setting does nothing.",
        hint: didYouMean(near),
      }),
    )
  }

  if (unfamiliar.length > 0) {
    findings.push(
      finding(
        "info",
        "agent.permission.unverified",
        `${where} sets ${unfamiliar.length} permission name${unfamiliar.length === 1 ? "" : "s"} that are not built-in tools`,
        {
          detail: unfamiliar.join(", "),
          hint: "These are usually MCP or plugin tools, which are only known once the server connects. A misspelling here silently never matches.",
        },
      ),
    )
  }

  for (const key of Object.keys(config.options ?? {})) {
    const near = suggest(key, AGENT_KEYS, 1)
    if (near.length === 0) continue
    findings.push(
      finding("warn", "agent.options.typo", `${where} sets "${key}", which looks like a typo of "${near[0]}"`, {
        detail: `Unknown agent keys are folded into "options" and forwarded to the provider instead of "${near[0]}".`,
      }),
    )
  }

  return findings
}

export function checkAgent(name: string, input: AgentCheckInput): Finding[] {
  const findings = checkAgentKeys(name, input.config, input.knownKeys)
  if (input.config.model !== undefined) {
    findings.push(...checkModel({ raw: input.config.model, catalog: input.catalog, subject: `Agent "${name}"` }))
  }
  if (input.config.disable === true) {
    findings.push(
      finding("info", "agent.disabled", `Agent "${name}" is disabled`, {
        detail: 'Set "disable": false or remove the entry to re-enable it.',
      }),
    )
  }
  if (name === input.defaultAgent) {
    if (input.defaultAgentMode === undefined) {
      findings.push(
        finding("error", "agent.default.missing", `default_agent names "${name}", which does not exist`, {
          hint: "Point default_agent at a configured agent, or remove it to use the first primary agent.",
        }),
      )
    } else if (input.defaultAgentMode === "subagent") {
      findings.push(
        finding("error", "agent.default.subagent", `default_agent names "${name}", which is a subagent`, {
          detail: "A subagent cannot be the session agent; starting a session with this config throws.",
        }),
      )
    } else if (input.defaultAgentHidden) {
      findings.push(
        finding("error", "agent.default.hidden", `default_agent names "${name}", which is hidden`, {
          detail: "Starting a session with this config throws.",
        }),
      )
    }
  }
  return findings
}

/** Config directories that define the same agent name, in precedence order. */
export function checkAgentShadowing(input: {
  readonly sources: Readonly<Record<string, readonly string[]>>
}): Finding[] {
  const findings: Finding[] = []
  for (const name of Object.keys(input.sources).toSorted()) {
    const dirs = input.sources[name]
    if (dirs.length < 2) continue
    findings.push(
      finding("warn", "agent.shadowed", `Agent "${name}" is defined in ${dirs.length} config directories`, {
        detail: dirs.map((dir, index) => `${index === 0 ? "wins" : "shadowed by"}: ${dir}`).join("\n"),
        hint: "Merged values take the first directory that sets each key; rename or remove the losing file.",
      }),
    )
  }
  return findings
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface ProviderCheckInput {
  /** Providers something is actually pointing at, with the reason. */
  readonly referenced: readonly { readonly providerID: string; readonly subject: string }[]
  /** Providers that resolved to a live provider, i.e. have usable credentials. */
  readonly connected: ReadonlySet<string>
  /** Env var names per provider, for the hint. */
  readonly env: Readonly<Record<string, readonly string[]>>
}

export function checkProviders(input: ProviderCheckInput): Finding[] {
  const findings: Finding[] = []
  const seen = new Map<string, string[]>()
  for (const item of input.referenced) {
    const list = seen.get(item.providerID)
    if (list) list.push(item.subject)
    else seen.set(item.providerID, [item.subject])
  }
  for (const providerID of [...seen.keys()].toSorted()) {
    if (input.connected.has(providerID)) continue
    const subjects = seen.get(providerID)!
    const vars = input.env[providerID] ?? []
    findings.push(
      finding("warn", "provider.credentials-missing", `Provider "${providerID}" has no credentials`, {
        detail: `Referenced by ${subjects.join(", ")}, but no key, token, or env var resolved to a live provider.`,
        hint:
          vars.length > 0
            ? `Set one of ${vars.map((name) => `$${name}`).join(", ")} or run \`opencode auth login\`.`
            : "Run `opencode auth login` for this provider.",
      }),
    )
  }
  return findings
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export type McpStatus =
  | { readonly status: "connected" }
  | { readonly status: "disabled" }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "needs_auth" }
  | { readonly status: "needs_client_registration"; readonly error: string }

export interface McpCheckInput {
  /** Name to config for every configured server. */
  readonly configured: Readonly<
    Record<
      string,
      | { readonly type: "local"; readonly command: readonly string[] }
      | { readonly type: "remote"; readonly url: string }
    >
  >
  readonly status: Readonly<Record<string, McpStatus>>
  /** Resolved path of a local server's executable, or null when not on PATH. */
  readonly commandPaths: Readonly<Record<string, string | null>>
}

export function checkMcp(input: McpCheckInput): Finding[] {
  const findings: Finding[] = []
  for (const name of Object.keys(input.configured).toSorted()) {
    const config = input.configured[name]
    const status = input.status[name]?.status
    if (status === "failed") {
      const error = (input.status[name] as { error: string }).error
      findings.push(finding("error", "mcp.failed", `MCP server "${name}" failed`, { detail: error }))
      continue
    }
    if (status === "needs_auth") {
      findings.push(
        finding("warn", "mcp.needs-auth", `MCP server "${name}" needs authentication`, {
          hint: `Run \`opencode mcp auth ${name}\`.`,
        }),
      )
      continue
    }
    if (status === "needs_client_registration") {
      const error = (input.status[name] as { error: string }).error
      findings.push(
        finding("warn", "mcp.needs-client-registration", `MCP server "${name}" needs client registration`, {
          detail: error,
          hint: `Set "oauth": { "clientId": "..." } under mcp.${name}, or re-run \`opencode mcp auth ${name}\`.`,
        }),
      )
      continue
    }
    if (status === "disabled") {
      findings.push(
        finding("info", "mcp.disabled", `MCP server "${name}" is disabled`, {
          detail: 'Set "enabled": true to start it.',
        }),
      )
      continue
    }
    if (status === "connected" && config?.type === "local") {
      const executable = config.command[0]
      if (executable && input.commandPaths[name] === null) {
        findings.push(
          finding("error", "mcp.command-missing", `MCP server "${name}" runs "${executable}", which is not on PATH`, {
            hint: "Install the executable, or give an absolute path in the server's command.",
          }),
        )
      }
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// Binaries and environment
// ---------------------------------------------------------------------------

export interface BinaryCheckInput {
  /** Resolved path per binary, or null when it could not be found. */
  readonly paths: Readonly<Record<string, string | null>>
  /** What breaks when the binary is missing. */
  readonly requiredFor: Readonly<Record<string, string>>
}

export function checkBinaries(input: BinaryCheckInput): Finding[] {
  return Object.keys(input.paths)
    .toSorted()
    .flatMap((name) => {
      const resolved = input.paths[name]
      if (resolved) return [finding("ok", `binary.${name}`, `${name} found`, { detail: resolved })]
      return [
        finding("error", `binary.${name}.missing`, `${name} was not found on PATH`, {
          detail: input.requiredFor[name],
        }),
      ]
    })
}

export interface EnvironmentCheckInput {
  readonly dataDir: string
  readonly database: string
  readonly configDirectories: readonly string[]
  readonly plugins: readonly string[]
}

export function checkEnvironment(input: EnvironmentCheckInput): Finding[] {
  const findings: Finding[] = []
  findings.push(
    finding("info", "env.data", `Data directory`, { detail: input.dataDir }),
    finding("info", "env.database", `Database`, { detail: input.database }),
  )
  if (input.configDirectories.length === 0) {
    findings.push(
      finding("warn", "env.no-config", "No opencode config directory was found", {
        detail: "Agent, command, and plugin definitions under .opencode/ or ~/.config/opencode are not being loaded.",
      }),
    )
  } else {
    findings.push(
      finding("info", "env.config", `Config directories (highest precedence first)`, {
        detail: input.configDirectories.join("\n"),
      }),
    )
  }
  if (input.plugins.length > 0) {
    findings.push(finding("info", "env.plugins", `Plugins loaded`, { detail: input.plugins.join("\n") }))
  }
  return findings
}
