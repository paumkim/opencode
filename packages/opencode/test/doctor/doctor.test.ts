import { describe, expect, test } from "bun:test"
import { Doctor } from "../../src/doctor/doctor"
import { DoctorRender } from "../../src/doctor/render"
import type { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"

const catalog: Doctor.ModelCatalog = {
  providers: {
    anthropic: ["claude-sonnet-4-5", "claude-opus-4-1"],
    openai: ["gpt-5", "gpt-4o"],
  },
  disabled: new Set(["openai"]),
}

const knownKeys = new Set<string>([...Doctor.PERMISSION_KEYS, "bash", "read", "edit", "write", "patch", "grep", "glob"])

/**
 * Mirrors what `ConfigAgentV1.Info` does to a decoded agent: unknown keys are
 * folded into `options`, and the deprecated `tools` map is folded into
 * `permission`. The checks consume the decoded shape, so the fixtures have to
 * reproduce it or they would test a shape the runtime never sees.
 */
const agent = (value: Record<string, unknown>): ConfigAgentV1.Info =>
  ({
    options: {},
    ...value,
  }) as ConfigAgentV1.Info

const ids = (findings: readonly Doctor.Finding[]) => findings.map((item) => item.id)

describe("doctor.parseModelReference", () => {
  test("splits on the first slash and keeps slashes in the model id", () => {
    expect(Doctor.parseModelReference("openrouter/anthropic/claude")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude",
    })
  })

  test("rejects the shapes Provider.parseModel silently accepts", () => {
    expect(Doctor.parseModelReference("gpt-5")).toBeUndefined()
    expect(Doctor.parseModelReference("openai/")).toBeUndefined()
    expect(Doctor.parseModelReference("/gpt-5")).toBeUndefined()
    expect(Doctor.parseModelReference("")).toBeUndefined()
  })
})

describe("doctor.checkModel", () => {
  test("accepts a known provider and model", () => {
    expect(Doctor.checkModel({ raw: "anthropic/claude-opus-4-1", catalog, subject: 'Agent "build"' })).toEqual([])
  })

  test("flags a malformed model string as an error", () => {
    const [only] = Doctor.checkModel({ raw: "claude", catalog, subject: 'Config "model"' })
    expect(only.severity).toBe("error")
    expect(only.id).toBe("model.malformed")
    expect(only.title).toContain('Config "model"')
  })

  test("flags an unknown provider and suggests a near match", () => {
    const [only] = Doctor.checkModel({ raw: "anthropiks/claude-opus-4-1", catalog, subject: 'Agent "a"' })
    expect(only.id).toBe("model.provider-unknown")
    expect(only.hint).toBe("Did you mean: anthropic?")
  })

  test("flags an unknown model and suggests the closest first", () => {
    const [only] = Doctor.checkModel({ raw: "anthropic/claude-sonnet-4-6", catalog, subject: 'Agent "a"' })
    expect(only.id).toBe("model.unknown")
    expect(only.hint).toBe("Did you mean: claude-sonnet-4-5, claude-opus-4-1?")
  })

  test("warns when the model exists but its provider is disabled", () => {
    const [only] = Doctor.checkModel({ raw: "openai/gpt-5", catalog, subject: 'Agent "a"' })
    expect(only.severity).toBe("warn")
    expect(only.id).toBe("model.provider-disabled")
  })
})

describe("doctor.checkAgent", () => {
  const check = (config: ConfigAgentV1.Info, extra: Partial<Parameters<typeof Doctor.checkAgent>[1]> = {}) =>
    Doctor.checkAgent("reviewer", { config, knownKeys, catalog, ...extra })

  test("reports nothing for a well-formed agent", () => {
    expect(check(agent({ model: "anthropic/claude-sonnet-4-5", permission: { bash: "ask" }, options: {} }))).toEqual([])
  })

  test("flags the deprecated maxSteps field", () => {
    expect(ids(check(agent({ maxSteps: 4 })))).toEqual(["agent.maxSteps.deprecated"])
  })

  test("flags a maxSteps/steps disagreement", () => {
    const findings = check(agent({ maxSteps: 4, steps: 9 }))
    expect(ids(findings)).toEqual(["agent.maxSteps.deprecated", "agent.steps.conflict"])
    expect(findings[1].detail).toContain("steps=9")
  })

  test("accepts maxSteps when it agrees with steps", () => {
    expect(ids(check(agent({ maxSteps: 4, steps: 4 })))).toEqual(["agent.maxSteps.deprecated"])
  })

  test("flags the deprecated tools field", () => {
    expect(ids(check(agent({ tools: { bash: true } })))).toEqual(["agent.tools.deprecated"])
  })

  test("flags the penalty fields the schema accepts but nothing applies", () => {
    expect(ids(check(agent({ frequency_penalty: 0.2, presence_penalty: 0.2 })))).toEqual([
      "agent.frequency_penalty.ignored",
      "agent.presence_penalty.ignored",
    ])
  })

  test("warns about a permission key that is a near miss of a real one", () => {
    const [only] = check(agent({ permission: { bashh: "allow" } }))
    expect(only.severity).toBe("warn")
    expect(only.id).toBe("agent.permission.typo")
    expect(only.title).toContain('"bashh"')
    expect(only.hint).toBe("Did you mean: bash?")
  })

  test("reports unfamiliar permission names as unverified, not as typos", () => {
    // An MCP tool name is a legitimate permission name, and the registry cannot
    // enumerate one without connecting to the server that provides it.
    const [only] = check(agent({ permission: { "context7_query-docs": "allow" } }))
    expect(only.severity).toBe("info")
    expect(only.id).toBe("agent.permission.unverified")
    expect(only.detail).toBe("context7_query-docs")
  })

  test("groups unfamiliar permission names into one finding", () => {
    const findings = check(agent({ permission: { memory_save: "deny", wiki_read: "allow" } }))
    expect(ids(findings)).toEqual(["agent.permission.unverified"])
    expect(findings[0].detail).toBe("memory_save, wiki_read")
  })

  test("accepts a permission name that names a known tool or permission", () => {
    expect(check(agent({ permission: { bash: "deny", doom_loop: "ask", plan_enter: "allow" } }))).toEqual([])
  })

  test("leaves wildcard permission names alone", () => {
    expect(check(agent({ permission: { "*_*": "deny", "memory_*": "deny" } }))).toEqual([])
  })

  test("flags an unknown agent option that is a near miss of a real field", () => {
    const [only] = check(agent({ options: { temperture: 0.5 } }))
    expect(only.id).toBe("agent.options.typo")
    expect(only.title).toContain("temperture")
    expect(only.title).toContain("temperature")
  })

  test("leaves genuine provider options alone", () => {
    expect(check(agent({ options: { reasoningEffort: "high" } }))).toEqual([])
  })

  test("notes a disabled agent without calling it broken", () => {
    const [only] = check(agent({ disable: true }))
    expect(only.severity).toBe("info")
    expect(only.id).toBe("agent.disabled")
  })

  test("errors when default_agent names an agent that does not exist", () => {
    const findings = Doctor.checkAgent("reviewer", {
      config: agent({}),
      knownKeys,
      catalog,
      defaultAgent: "reviewer",
      defaultAgentMode: undefined,
    })
    expect(ids(findings)).toEqual(["agent.default.missing"])
  })

  test("errors when default_agent names a subagent", () => {
    const findings = Doctor.checkAgent("reviewer", {
      config: agent({}),
      knownKeys,
      catalog,
      defaultAgent: "reviewer",
      defaultAgentMode: "subagent",
    })
    expect(ids(findings)).toEqual(["agent.default.subagent"])
  })

  test("errors when default_agent names a hidden agent", () => {
    const findings = Doctor.checkAgent("reviewer", {
      config: agent({}),
      knownKeys,
      catalog,
      defaultAgent: "reviewer",
      defaultAgentMode: "primary",
      defaultAgentHidden: true,
    })
    expect(ids(findings)).toEqual(["agent.default.hidden"])
  })

  test("stays quiet when default_agent names a usable agent", () => {
    expect(
      Doctor.checkAgent("reviewer", {
        config: agent({}),
        knownKeys,
        catalog,
        defaultAgent: "reviewer",
        defaultAgentMode: "primary",
      }),
    ).toEqual([])
  })
})

describe("doctor.checkAgentShadowing", () => {
  test("reports an agent defined in more than one config directory", () => {
    const findings = Doctor.checkAgentShadowing({
      sources: { build: ["/p/.opencode", "/root/.config/opencode"], plan: ["/p/.opencode"] },
    })
    expect(ids(findings)).toEqual(["agent.shadowed"])
    expect(findings[0].detail).toContain("wins: /p/.opencode")
    expect(findings[0].detail).toContain("shadowed by: /root/.config/opencode")
  })

  test("reports nothing when every agent is defined once", () => {
    expect(Doctor.checkAgentShadowing({ sources: { build: ["/p/.opencode"] } })).toEqual([])
  })
})

describe("doctor.checkProviders", () => {
  test("warns for a referenced provider with no credentials and names the env vars", () => {
    const [only] = Doctor.checkProviders({
      referenced: [{ providerID: "anthropic", subject: 'agent "build"' }],
      connected: new Set(),
      env: { anthropic: ["ANTHROPIC_API_KEY"] },
    })
    expect(only.severity).toBe("warn")
    expect(only.id).toBe("provider.credentials-missing")
    expect(only.detail).toContain('agent "build"')
    expect(only.hint).toContain("$ANTHROPIC_API_KEY")
  })

  test("lists every reference to a missing provider", () => {
    const [only] = Doctor.checkProviders({
      referenced: [
        { providerID: "anthropic", subject: 'agent "build"' },
        { providerID: "anthropic", subject: 'config "model"' },
      ],
      connected: new Set(),
      env: { anthropic: ["ANTHROPIC_API_KEY"] },
    })
    expect(only.detail).toContain('agent "build", config "model"')
  })

  test("says nothing about a provider that is connected", () => {
    expect(
      Doctor.checkProviders({
        referenced: [{ providerID: "anthropic", subject: 'agent "build"' }],
        connected: new Set(["anthropic"]),
        env: { anthropic: ["ANTHROPIC_API_KEY"] },
      }),
    ).toEqual([])
  })
})

describe("doctor.checkMcp", () => {
  const local = { type: "local", command: ["node", "server.js"] } as const
  const remote = { type: "remote", url: "https://mcp.example.com" } as const

  test("errors on a server that failed, passing the error through", () => {
    const [only] = Doctor.checkMcp({
      configured: { docs: local },
      status: { docs: { status: "failed", error: "spawn ENOENT" } },
      commandPaths: {},
    })
    expect(only.severity).toBe("error")
    expect(only.detail).toBe("spawn ENOENT")
  })

  test("warns on a server that needs authentication and names the command", () => {
    const [only] = Doctor.checkMcp({
      configured: { docs: remote },
      status: { docs: { status: "needs_auth" } },
      commandPaths: {},
    })
    expect(only.id).toBe("mcp.needs-auth")
    expect(only.hint).toBe("Run `opencode mcp auth docs`.")
  })

  test("warns on a server awaiting client registration", () => {
    const [only] = Doctor.checkMcp({
      configured: { docs: remote },
      status: { docs: { status: "needs_client_registration", error: "registration rejected" } },
      commandPaths: {},
    })
    expect(only.id).toBe("mcp.needs-client-registration")
  })

  test("notes a disabled server as information", () => {
    const [only] = Doctor.checkMcp({
      configured: { docs: local },
      status: { docs: { status: "disabled" } },
      commandPaths: { docs: "/usr/bin/node" },
    })
    expect(only.severity).toBe("info")
  })

  test("errors when a connected local server runs a command that is not on PATH", () => {
    const [only] = Doctor.checkMcp({
      configured: { docs: { type: "local", command: ["definitely-not-installed"] } },
      status: { docs: { status: "connected" } },
      commandPaths: { docs: null },
    })
    expect(only.severity).toBe("error")
    expect(only.id).toBe("mcp.command-missing")
  })

  test("does not check the command of a remote server", () => {
    expect(
      Doctor.checkMcp({
        configured: { docs: remote },
        status: { docs: { status: "connected" } },
        commandPaths: {},
      }),
    ).toEqual([])
  })

  test("says nothing about a connected local server whose command resolves", () => {
    expect(
      Doctor.checkMcp({
        configured: { docs: local },
        status: { docs: { status: "connected" } },
        commandPaths: { docs: "/usr/bin/node" },
      }),
    ).toEqual([])
  })
})

describe("doctor.checkBinaries", () => {
  test("reports the resolved path as ok", () => {
    const [only] = Doctor.checkBinaries({ paths: { git: "/usr/bin/git" }, requiredFor: { git: "undo" } })
    expect(only.severity).toBe("ok")
    expect(only.detail).toBe("/usr/bin/git")
  })

  test("errors and explains the consequence when a binary is missing", () => {
    const [only] = Doctor.checkBinaries({ paths: { git: null }, requiredFor: { git: "Session undo needs git." } })
    expect(only.severity).toBe("error")
    expect(only.detail).toBe("Session undo needs git.")
  })
})

describe("doctor.report", () => {
  const findings: Doctor.Finding[] = [
    Doctor.finding("error", "model.unknown", "broken"),
    Doctor.finding("warn", "agent.tools.deprecated", "stale"),
    Doctor.finding("info", "env.data", "info"),
    Doctor.finding("ok", "binary.git", "fine"),
  ]

  test("summarizes by severity", () => {
    expect(Doctor.summarize(findings)).toEqual({ error: 1, warn: 1, info: 1, ok: 1 })
  })

  test("exits non-zero only when something is broken", () => {
    expect(Doctor.exitCode(findings)).toBe(1)
    expect(Doctor.exitCode(findings.filter((item) => item.severity !== "error"))).toBe(0)
  })

  test("sorts errors first, then by id", () => {
    expect(Doctor.sort(findings).map((item) => item.id)).toEqual([
      "model.unknown",
      "agent.tools.deprecated",
      "env.data",
      "binary.git",
    ])
  })

  test("does not mutate the input", () => {
    const input = [...findings]
    Doctor.sort(input)
    expect(input.map((item) => item.id)).toEqual(findings.map((item) => item.id))
  })
})

describe("doctor.suggest", () => {
  test("ranks an exact match first, then substrings, then edits", () => {
    expect(Doctor.suggest("gpt-5", ["gpt-4o", "gpt-5", "gpt-5-mini", "claude"])).toEqual([
      "gpt-5",
      "gpt-5-mini",
      "gpt-4o",
    ])
  })

  test("honours the limit", () => {
    expect(Doctor.suggest("gpt-5", ["gpt-4o", "gpt-5", "gpt-5-mini"], 1)).toEqual(["gpt-5"])
  })

  test("returns nothing for an empty query", () => {
    expect(Doctor.suggest("  ", ["gpt-5"])).toEqual([])
  })

  test("returns nothing when no candidate is close enough", () => {
    expect(Doctor.suggest("zzz", ["gpt-4o", "claude-opus-4-1"])).toEqual([])
  })

  test("ignores case", () => {
    expect(Doctor.distance("Bash", "bash")).toBe(0)
    expect(Doctor.suggest("BASH", ["bash", "read"])).toEqual(["bash"])
  })
})

describe("doctor.render", () => {
  const findings: Doctor.Finding[] = [
    Doctor.finding("error", "model.unknown", 'Agent "build" uses the unknown model "a/b"', {
      detail: "Provider a has no model b.",
      hint: "Did you mean: a/c?",
    }),
    Doctor.finding("ok", "binary.git", "git found", { detail: "/usr/bin/git" }),
    Doctor.finding("info", "env.data", "Data directory", { detail: "/root/.local/share/opencode" }),
  ]

  test("renders a plain report with severity, detail, and hint", () => {
    const text = DoctorRender.renderText(findings, { plain: true })
    expect(text).toContain('[error] Agent "build" uses the unknown model "a/b"')
    expect(text).toContain("    Provider a has no model b.")
    expect(text).toContain("    → Did you mean: a/c?")
    expect(text).toContain("1 error, 1 info, 1 ok")
    expect(text).not.toContain("\u001b")
  })

  test("brief mode keeps only errors and warnings", () => {
    const text = DoctorRender.renderText(findings, { plain: true, brief: true })
    expect(text).toContain("[error]")
    expect(text).not.toContain("git found")
    expect(text).not.toContain("Data directory")
  })

  test("brief mode says so plainly when there is nothing wrong", () => {
    const text = DoctorRender.renderText([Doctor.finding("ok", "binary.git", "git found")], {
      plain: true,
      brief: true,
    })
    expect(text.trim()).toBe("No problems found.")
  })

  test("json mode carries the summary and the findings", () => {
    const parsed = JSON.parse(DoctorRender.renderJSON(findings, { plain: true }))
    expect(parsed.summary).toEqual({ error: 1, warn: 0, info: 1, ok: 1 })
    expect(parsed.findings).toHaveLength(3)
    expect(parsed.findings[0]).toMatchObject({ id: "model.unknown", severity: "error" })
  })
})
