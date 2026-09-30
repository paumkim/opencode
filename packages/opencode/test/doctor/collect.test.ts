import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { MCP } from "../../src/mcp"
import { Provider } from "../../src/provider/provider"
import { ToolRegistry } from "../../src/tool/registry"
import { Doctor } from "../../src/doctor/doctor"
import { DoctorCollect } from "../../src/doctor/collect"

// The collector is the only part of doctor that touches services, so this is the
// layer set it actually yields. `mcp: false` keeps the assertions from depending
// on which third-party MCP servers happen to be reachable.
const layer = LayerNode.compile(
  LayerNode.group([
    Config.node,
    Agent.node,
    Auth.node,
    ModelsDev.node,
    Provider.node,
    ToolRegistry.node,
    MCP.node,
    FSUtil.node,
  ]),
)

const it = testEffect(layer)

const collect = Effect.fn("Test.collect")(function* () {
  return yield* DoctorCollect.collect({ mcp: false })
})

const titles = (findings: readonly Doctor.Finding[], id: string) =>
  findings.filter((item) => item.id === id).map((item) => item.title)

describe("doctor.collect", () => {
  it.instance(
    "reports a permission name that is a near miss of a real tool",
    () =>
      collect().pipe(
        Effect.map((findings) => {
          expect(titles(findings, "agent.permission.typo")).toEqual([
            'Agent "worker" sets "bashh", which looks like a typo of "bash"',
          ])
        }),
      ),
    { config: { agent: { worker: { permission: { bashh: "allow" } } } } },
  )

  it.instance(
    "reports an unknown provider on a configured agent",
    () =>
      collect().pipe(
        Effect.map((findings) => {
          expect(titles(findings, "model.provider-unknown")).toEqual([
            'Agent "worker" uses the unknown provider "no-such-provider"',
          ])
        }),
      ),
    { config: { agent: { worker: { model: "no-such-provider/no-such-model" } } } },
  )

  it.instance(
    "reports a missing credential for a referenced provider",
    () =>
      collect().pipe(
        Effect.map((findings) => {
          expect(titles(findings, "provider.credentials-missing")).toEqual([
            'Provider "definitely-unconnected" has no credentials',
          ])
        }),
      ),
    { config: { model: "definitely-unconnected/model-x" } },
  )

  it.instance(
    "says nothing about a model that resolves to a known provider",
    () =>
      collect().pipe(
        Effect.map((findings) => {
          expect(titles(findings, "model.unknown")).toEqual([])
          expect(titles(findings, "model.provider-unknown")).toEqual([])
        }),
      ),
    { config: { model: "openai/gpt-4o" } },
  )

  it.instance(
    "always reports the environment",
    () =>
      collect().pipe(
        Effect.map((findings) => {
          expect(titles(findings, "env.data")).toHaveLength(1)
          expect(titles(findings, "env.database")).toHaveLength(1)
          expect(titles(findings, "env.config")).toHaveLength(1)
        }),
      ),
    { config: {} },
  )

  it.instance(
    "reports both external binaries it depends on",
    () =>
      collect().pipe(
        Effect.map((findings) => {
          // `git` backs the snapshot/undo path and ripgrep backs grep/glob, so
          // both are always reported — present or not.
          const binaries = findings.filter((item) => item.id.startsWith("binary."))
          expect(binaries.map((item) => item.id).toSorted()).toEqual(["binary.git", "binary.ripgrep"])
        }),
      ),
    { config: {} },
  )
})
