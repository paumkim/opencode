import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FanoutDelivery } from "@opencode-ai/core/fanout/delivery"
import { applicationServices } from "@opencode-ai/server/routes"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"

/**
 * The fan-out delivery node is the only subscriber to `FanoutEvent.WorkerSettled`,
 * the only caller of `FanoutLifecycle.deliver`, and the only caller of
 * `execution.wake(parent)`. It also runs the boot-time unclaimed sweep.
 *
 * It is a `makeGlobalNode` whose construction has a side effect, so `compile`
 * cannot pull it in transitively: a production root that does not name it has no
 * delivery at all. Worker results then sit unclaimed in the ledger forever and a
 * fanned-out parent is never given a turn.
 *
 * The guard that was missing is over the PRODUCTION graphs. `fanout-tool.test.ts`
 * names the node in its own harness, so it passed while every real runtime was
 * broken; a test that only builds a graph it controls cannot catch that class of
 * bug.
 */

// Every production composition root that can run a v2 Session -- i.e. one that
// wires `SessionExecution` and therefore can execute a `fanout` tool call.
// `LayerNode.compile` builds a node only when a group names it or depends on it,
// so each of these is the complete set of construction-time nodes its runtime
// gets.
const productionRoots: { readonly name: string; readonly node: LayerNode.Node<unknown, unknown, any> }[] = [
  {
    name: "httpapi TUI/HTTP app group (packages/opencode/src/server/routes/instance/httpapi/server.ts)",
    node: HttpApiApp.app,
  },
  {
    name: "v2 embedded server application services (packages/server/src/routes.ts)",
    node: applicationServices,
  },
]

describe("FanoutDelivery wiring", () => {
  test.each(productionRoots)("$name lists the delivery node", ({ node }) => {
    expect(LayerNode.includes(node, FanoutDelivery.node)).toBe(true)
  })

  test("the guard itself detects a missing node", () => {
    // If this ever passes trivially the assertions above prove nothing.
    expect(LayerNode.includes(HttpApiApp.app, { kind: "group", name: "not-a-real-node", dependencies: [] })).toBe(
      false,
    )
  })
})
