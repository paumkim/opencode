import { describe, expect, test } from "bun:test"
import { agentColor } from "./agent"

// `defaults` is an object literal and the lookup used `??`, which stops on any
// non-nullish value — including an inherited one. An agent named after an
// Object.prototype member (agent names come from `.opencode/agent/<name>.md`,
// so a filename is enough) therefore resolved to the `Object` function, which
// was then rendered into a `color:` style where it is silently invalid.
const PROTOTYPE_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "__defineGetter__"]

describe("agentColor", () => {
  for (const key of PROTOTYPE_KEYS) {
    test(`${key} gets a real CSS color, not a function`, () => {
      const color = agentColor(key)
      expect(typeof color).toBe("string")
      expect(color.startsWith("var(--")).toBe(true)
    })
  }

  test("a known agent still gets its named color", () => {
    expect(agentColor("ask")).toBe("var(--icon-agent-ask-base)")
    expect(agentColor("build")).toBe("var(--icon-agent-build-base)")
  })

  test("an explicit custom color wins", () => {
    expect(agentColor("constructor", "#ff0000")).toBe("#ff0000")
  })

  test("an unknown agent falls back to a stable palette color", () => {
    const color = agentColor("some-unknown-agent")
    expect(typeof color).toBe("string")
    expect(color.startsWith("var(--")).toBe(true)
    expect(agentColor("some-unknown-agent")).toBe(color)
  })
})
