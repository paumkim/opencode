import { describe, expect, it } from "bun:test"
import { ToolCorrector } from "../src/protocols/utils/tool-correct"

const schema = {
  type: "object",
  properties: {
    command: { type: "string" },
    path: { type: "string" },
    count: { type: "number" },
  },
  required: ["command"],
} as const

describe("ToolCorrector", () => {
  it("passes valid input through unchanged", () => {
    const result = ToolCorrector.correctToolInput({ command: "ls -la" }, schema)
    expect(result.ok).toBe(true)
    expect(result.repaired).toBe(false)
    expect(result.input).toEqual({ command: "ls -la" })
  })

  it("fills missing required keys with undefined", () => {
    const result = ToolCorrector.correctToolInput({ path: "/a" }, schema)
    expect(result.ok).toBe(true)
    expect(result.repaired).toBe(true)
    expect(result.input.command).toBeUndefined()
    expect(result.input.path).toBe("/a")
    expect(result.message).toContain("missing required key")
  })

  it("drops null where a scalar is expected", () => {
    const result = ToolCorrector.correctToolInput({ command: null, path: "/a" }, schema)
    expect(result.ok).toBe(true)
    expect(result.repaired).toBe(true)
    expect(result.input.command).toBeUndefined()
    expect(result.message).toContain("null")
  })

  it("repairs stringified JSON inside a string field", () => {
    const result = ToolCorrector.correctToolInput(
      { command: '{"command":"ls","path":"/x"}' },
      schema,
    )
    expect(result.ok).toBe(true)
    expect(result.repaired).toBe(true)
    expect(result.input.command).toBe("ls")
    expect(result.input.path).toBe("/x")
  })

  it("fails when arguments are not an object", () => {
    const result = ToolCorrector.correctToolInput("not an object", schema)
    expect(result.ok).toBe(false)
    expect(result.repaired).toBe(false)
    expect(result.message).toContain("not a JSON object")
  })

  it("passes through when no schema is declared", () => {
    const result = ToolCorrector.correctToolInput({ anything: "goes" }, undefined)
    expect(result.ok).toBe(true)
    expect(result.repaired).toBe(false)
  })

  it("preserves unknown keys untouched", () => {
    const result = ToolCorrector.correctToolInput({ command: "ls", extra: "kept" }, schema)
    expect(result.ok).toBe(true)
    expect(result.input.extra).toBe("kept")
  })
})