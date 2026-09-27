import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "../../src/agent/agent"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Npm } from "@opencode-ai/core/npm"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Skill } from "../../src/skill"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderTest } from "../fake/provider"
import { SkillTest } from "../fake/skill"
import { testEffect } from "../lib/effect"

// `it.instance` skips InstanceBootstrap so LSP / MCP don't spin up; these tests
// only need config -> agent discovery.

// The built-in agent table is an object literal, so an agent named after an
// Object.prototype key used to read the INHERITED member instead of "no such
// agent": `agents["constructor"]` is the `Object` function, which is truthy, so
// the config-merge branch stopped creating an entry and then wrote config onto
// the global Object (`item.name = ...` throws on `Object.name` in strict mode).
// The user-reachable trigger is a plain file name — `.opencode/agent/constructor.md`.
const PROTOTYPE_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]

const provider = ProviderTest.fake()
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Agent.node, Plugin.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [Provider.node, provider.layer],
    [Skill.node, SkillTest.empty],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)

const writeAgentFile = (name: string) =>
  Effect.fn("PrototypeKeyAgent.write")(function* (directory: string) {
    yield* Effect.promise(() =>
      Bun.write(
        path.join(directory, ".opencode", "agent", `${name}.md`),
        `---
description: an agent named ${name}
---

do the thing
`,
      ),
    )
  })

for (const name of PROTOTYPE_KEYS) {
  it.instance(
    `an agent file named ${name}.md is a normal agent, not an Object.prototype member`,
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.use.list()
        const found = agents.find((a) => a.name === name)
        expect(found).toBeDefined()
        expect(found?.native).toBe(false)
        expect(found?.description).toContain(name)
        // The resolved agent must be a real object with a real ruleset. Before the
        // fix this was the inherited `Object` function: `permission` was undefined,
        // so deriving subagent permissions threw on `.some(...)`.
        expect(typeof found).toBe("object")
        expect(Array.isArray(found?.permission)).toBe(true)
        expect(found?.permission.every((rule) => typeof rule.permission === "string")).toBe(true)
      }),
    { init: writeAgentFile(name) },
  )
}

it.instance(
  "get() resolves a prototype-keyed agent to the real agent, not Object",
  () =>
    Effect.gen(function* () {
      // `constructor` is already lowercase, so get()'s normalization is a no-op
      // here and this pins the lookup itself. Before the fix get("constructor")
      // returned the `Object` function, which callers dereference as an agent.
      const got = yield* Agent.use.get("constructor")
      expect(typeof got).toBe("object")
      expect(got?.name).toBe("constructor")
      expect(Array.isArray(got?.permission)).toBe(true)
    }),
  { init: writeAgentFile("constructor") },
)

it.instance(
  "an unknown prototype-keyed name is still unknown, not a phantom agent",
  () =>
    Effect.gen(function* () {
      // No such file was written, so this must resolve to nothing. It used to
      // resolve to the `Object` function, which is truthy and therefore skipped
      // the "Unknown agent type" guard in the task tool.
      expect(yield* Agent.use.get("constructor")).toBeUndefined()
    }),
  { init: writeAgentFile("notconstructor") },
)

it.instance(
  "the global Object is not polluted with agent fields",
  () =>
    Effect.gen(function* () {
      yield* Agent.use.list()
      const polluted = ["prompt", "permission", "options", "description", "temperature", "color", "mode"].filter(
        (key) => key in Object,
      )
      expect(polluted).toEqual([])
    }),
  { init: writeAgentFile("constructor") },
)
