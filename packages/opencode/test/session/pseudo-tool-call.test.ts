import { describe, expect, it } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "../../src/tool/registry"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { InstanceState } from "../../src/effect/instance-state"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import {
  isKnownToolCall,
  KNOWN_TOOL_CALLS,
  parsePseudoToolCalls,
  stripPseudoToolCalls,
} from "../../src/session/pseudo-tool-call"
import { disposeAllInstances } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

// Same harness test/tool/registry.test.ts uses: a real registry in a clean temp
// instance, with no .opencode/tool directory and no plugins, so the ids it
// reports are exactly the builtins.
const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
})
const registry = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

describe("pseudo-tool-call", () => {
  it("parses an XML tool call and strips it from the text", () => {
    const text =
      'Working on it.\n<tool_call name="read">\n<parameter name="filePath">/tmp/a.ts</parameter>\n</tool_call>'

    expect(parsePseudoToolCalls(text)).toEqual([{ name: "read", input: { filePath: "/tmp/a.ts" } }])
    expect(stripPseudoToolCalls(text)).toBe("Working on it.")
  })

  it("parses a bracket tool call, taking the rest of the bracket as the path", () => {
    const calls = parsePseudoToolCalls("let me look [tool_call: read for /tmp/a.ts]")

    expect(calls).toEqual([{ name: "read", input: { path: "/tmp/a.ts" } }])
    expect(stripPseudoToolCalls("let me look [tool_call: read for /tmp/a.ts]")).toBe("let me look")
  })

  // The security property: a name that is not on the allowlist must survive
  // stripping untouched, so a smuggled call is visible in the transcript rather
  // than being silently executed or silently dropped.
  it.each(["rm_rf", "bash_actually", "read_file", "WebFetch"])("keeps an unlisted name %p as visible text", (name) => {
    const text = `<tool_call name="${name}"></tool_call> done`

    expect(isKnownToolCall(name)).toBe(false)
    expect(stripPseudoToolCalls(text)).toBe(text)
  })

  it("strips a listed name while leaving a neighbouring unlisted one alone", () => {
    const text = '<tool_call name="read"></tool_call> and <tool_call name="rm_rf"></tool_call>'

    expect(stripPseudoToolCalls(text)).toBe('and <tool_call name="rm_rf"></tool_call>')
  })

  it("reads a JSON parameter body as an object", () => {
    const calls = parsePseudoToolCalls('<tool_call name="write">{"filePath":"/tmp/a","content":"hi"}</tool_call>')

    expect(calls).toEqual([{ name: "write", input: { filePath: "/tmp/a", content: "hi" } }])
  })

  it("falls back to key=value parameters when the body is not JSON", () => {
    const calls = parsePseudoToolCalls('<tool_call name="bash">command="ls -la" timeout=30</tool_call>')

    expect(calls).toEqual([{ name: "bash", input: { command: "ls -la", timeout: "30" } }])
  })

  it("leaves ordinary prose alone", () => {
    const text = "I will read the file and then write the result. No markup here."

    expect(parsePseudoToolCalls(text)).toEqual([])
    expect(stripPseudoToolCalls(text)).toBe(text)
  })

  // The invariant the source comment claims. This is the test that was missing:
  // eleven builtin tools, including the whole goal family, were absent from the
  // allowlist, and nothing failed. A model emitting one of those as markup had
  // the markup left in the visible text and no tool part created.
  registry.instance("allowlists every builtin tool the registry can expose", () =>
    Effect.gen(function* () {
      const ids = yield* (yield* ToolRegistry.Service).ids()
      const missing = ids.filter((id) => !KNOWN_TOOL_CALLS.has(id))

      expect(missing).toEqual([])
      // A representative of the family that was missing, so a future edit that
      // drops the whole block fails with a name rather than an empty diff.
      expect(KNOWN_TOOL_CALLS.has("create_goal")).toBe(true)
    }),
  )

  // The allowlist is deliberately a superset: these are aliases models emit,
  // not registry ids, and `isKnownToolCall` has to accept them for the call to
  // resolve to a real tool.
  it.each(["todo", "list", "ls", "execute", "lsp", "plan_exit"])("keeps the %p alias on the allowlist", (name) => {
    expect(isKnownToolCall(name)).toBe(true)
  })
})
