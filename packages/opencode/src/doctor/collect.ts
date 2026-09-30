export * as DoctorCollect from "./collect"

import { Effect } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { which } from "@opencode-ai/core/util/which"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { ConfigAgent } from "@/config/agent"
import { ConfigPlugin } from "@/config/plugin"
import { MCP } from "@/mcp"
import { Provider } from "@/provider/provider"
import { Doctor } from "./doctor"
import { ToolRegistry } from "@/tool/registry"

export interface CollectInput {
  /**
   * Connect to configured MCP servers and report their status. On by default,
   * because a server that is not reachable is one of the more common reasons an
   * agent "cannot see" a tool. Pass `false` to skip it — the connection opens
   * every configured server, and a stdio server that ignores its `timeout` can
   * hold the command open. `opencode doctor --no-mcp` does exactly that.
   */
  readonly mcp?: boolean
}

/**
 * Gathers live instance state and runs the pure checks in {@link Doctor} over it.
 * Every check is a plain function over plain data, so this is the only module
 * that has to know about services — and the only one a test cannot cover without
 * booting an instance.
 */
export const collect = Effect.fn("Doctor.collect")(function* (input: CollectInput = {}) {
  const config = yield* Config.Service
  const agent = yield* Agent.Service
  const auth = yield* Auth.Service
  const catalog = yield* ModelsDev.Service.use((service) => service.get())
  const connected = yield* Provider.Service.use((service) => service.list())

  const cfg = yield* config.get()
  const directories = yield* config.directories()

  const providers: Record<string, readonly string[]> = {}
  const env: Record<string, readonly string[]> = {}
  for (const [id, provider] of Object.entries(catalog)) {
    providers[id] = Object.keys(provider.models)
    env[id] = provider.env
  }
  const models: Doctor.ModelCatalog = {
    providers,
    disabled: new Set(cfg.disabled_providers ?? []),
  }

  const findings: Doctor.Finding[] = []

  findings.push(
    ...Doctor.checkEnvironment({
      dataDir: Global.Path.data,
      database: Database.path(),
      configDirectories: directories,
      plugins: (cfg.plugin_origins ?? []).map(
        (origin) => `${ConfigPlugin.pluginSpecifier(origin.spec)}  (${origin.source})`,
      ),
    }),
  )

  findings.push(
    ...Doctor.checkBinaries({
      paths: { git: which("git") },
      requiredFor: { git: "Session undo and snapshot diffs need git." },
    }),
    ...(yield* ripgrepFinding),
  )

  // Tool ids come from the registry rather than a local list, so a plugin that
  // registers its own tool is known-good without this module tracking plugins.
  const registry = yield* ToolRegistry.Service
  const knownKeys = new Set<string>([...Doctor.PERMISSION_KEYS, ...(yield* registry.ids().pipe(Effect.orDie))])

  const resolvedAgents = yield* agent.list().pipe(Effect.orDie)
  const defaultAgent = cfg.default_agent
  const defaultInfo = defaultAgent ? resolvedAgents.find((item) => item.name === defaultAgent) : undefined

  for (const [name, definition] of Object.entries(cfg.agent ?? {})) {
    findings.push(
      ...Doctor.checkAgent(name, {
        config: definition,
        knownKeys,
        catalog: models,
        defaultAgent,
        defaultAgentMode: defaultInfo?.mode,
        defaultAgentHidden: defaultInfo?.hidden,
      }),
    )
  }

  for (const key of ["model", "small_model"] as const) {
    const raw = cfg[key]
    if (!raw) continue
    findings.push(...Doctor.checkModel({ raw, catalog: models, subject: `Config "${key}"` }))
  }

  findings.push(...(yield* shadowing(directories)))

  // A provider is "connected" when the runtime resolved it from a credential, or
  // when auth.json holds an entry for it — the same test the provider HTTP
  // handler uses, so `doctor` and the UI agree on who is logged in.
  const credentials = yield* auth.all().pipe(Effect.orDie)
  const connectedIDs = new Set([
    ...Object.keys(connected),
    ...Object.keys(credentials).filter((id) => !models.disabled?.has(id)),
  ])

  const referenced: { providerID: string; subject: string }[] = []
  for (const [name, definition] of Object.entries(cfg.agent ?? {})) {
    const ref = definition.model ? Doctor.parseModelReference(definition.model) : undefined
    if (ref) referenced.push({ providerID: ref.providerID, subject: `agent "${name}"` })
  }
  for (const key of ["model", "small_model"] as const) {
    const ref = cfg[key] ? Doctor.parseModelReference(cfg[key]!) : undefined
    if (ref) referenced.push({ providerID: ref.providerID, subject: `config "${key}"` })
  }
  if (referenced.length > 0) {
    findings.push(...Doctor.checkProviders({ referenced, connected: connectedIDs, env }))
  }

  if (input.mcp !== false) {
    const mcp = yield* MCP.Service
    const configured: Record<string, ConfigMCPV1.Info> = {}
    for (const [name, entry] of Object.entries(cfg.mcp ?? {})) {
      if (entry && typeof entry === "object" && "type" in entry) configured[name] = entry
    }
    const commandPaths: Record<string, string | null> = {}
    for (const [name, entry] of Object.entries(configured)) {
      if (entry.type === "local" && entry.command[0]) commandPaths[name] = which(entry.command[0])
    }
    findings.push(
      ...Doctor.checkMcp({
        configured,
        status: yield* mcp.status(),
        commandPaths,
      }),
    )
  }

  return Doctor.sort(findings)
})

/**
 * `RipgrepBinary.filepath` downloads ripgrep from GitHub when it is not on
 * PATH, so calling it from a diagnostic would turn `opencode doctor` into a
 * network fetch. The bundled copy is checked directly instead and the download
 * is reported as a first-run cost rather than performed.
 */
const ripgrepFinding: Effect.Effect<Doctor.Finding[], never, FSUtil.Service> = Effect.gen(function* () {
  const name = process.platform === "win32" ? "rg.exe" : "rg"
  const system = which(name)
  if (system) return [Doctor.finding("ok", "binary.ripgrep", "ripgrep found", { detail: system })]

  const bundled = path.join(Global.Path.bin, name)
  if (yield* FSUtil.Service.use((fs) => fs.isFile(bundled).pipe(Effect.orDie))) {
    return [Doctor.finding("ok", "binary.ripgrep", "ripgrep found", { detail: bundled })]
  }
  return [
    Doctor.finding("warn", "binary.ripgrep.missing", "ripgrep is not installed", {
      detail: `The grep and glob tools fall back to ${bundled}, which is downloaded from GitHub on first use.`,
      hint: "Install ripgrep with your package manager to avoid the download.",
    }),
  ]
})

/**
 * `Config` merges agent definitions with `mergeDeep`, so the same agent name in
 * a project directory and a global one silently blends into a third agent. This
 * re-reads the per-directory definitions purely to report which names collide.
 */
const shadowing = (directories: readonly string[]) =>
  Effect.gen(function* () {
    const sources: Record<string, string[]> = {}
    for (const dir of directories) {
      const loaded = yield* Effect.promise(() => ConfigAgent.load(dir)).pipe(
        Effect.catchCause(() => Effect.succeed({})),
      )
      for (const name of Object.keys(loaded)) (sources[name] ??= []).push(dir)
    }
    return Doctor.checkAgentShadowing({ sources })
  })
