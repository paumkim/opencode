import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "../src/agent"
import { FileSystem } from "../src/filesystem"
import { Model } from "../src/model"
import { Project } from "../src/project"
import { Pty } from "../src/pty"
import { Question } from "../src/question"
import { Session } from "../src/session"
import { SessionTodo } from "../src/session-todo"
import { optional } from "../src/schema"

describe("contract hygiene", () => {
  test("optional properties preserve transformations and omit undefined while encoding", () => {
    const Value = Schema.Struct({ value: optional(Schema.FiniteFromString) })
    expect(Schema.decodeUnknownSync(Value)({ value: "1" })).toEqual({ value: 1 })
    expect(Schema.encodeSync(Value)({ value: 1 })).toEqual({ value: "1" })
    expect(Schema.encodeSync(Value)({ value: undefined })).toEqual({})
  })

  test("todo status and priority are the closed sets the consumers compare against", () => {
    const decode = Schema.decodeUnknownSync(SessionTodo.Info)
    expect(decode({ content: "ship", status: "in_progress", priority: "high" })).toEqual({
      content: "ship",
      status: "in_progress",
      priority: "high",
    })
    // The descriptions named these exact four and three values, and every consumer compares against
    // them literally: the TUI sidebar shows itself while any todo is not "completed", the desktop
    // dock counts "completed" exactly and picks the active row by "in_progress" then "pending", and
    // the tool title counts anything not "completed" as outstanding. Accepting an arbitrary string
    // therefore pinned the progress indicator below its total and the sidebar open, permanently and
    // with no error anywhere - so the sets are closed in the schema, not just in the prose.
    expect(() => decode({ content: "ship", status: "waiting", priority: "urgent" })).toThrow()
    expect(() => decode({ content: "ship", status: "done", priority: "high" })).toThrow()
    expect(() => decode({ content: "ship", status: "pending", priority: "urgent" })).toThrow()
  })

  test("isInfo accepts only rows inside the todo contract", () => {
    expect(SessionTodo.isInfo({ status: "completed", priority: "low" })).toBe(true)
    expect(SessionTodo.isInfo({ status: "waiting", priority: "urgent" })).toBe(false)
    expect(SessionTodo.isInfo({ status: "completed", priority: "urgent" })).toBe(false)
    expect(SessionTodo.isInfo({ status: undefined, priority: "low" })).toBe(false)
    expect(SessionTodo.isInfo({ status: "pending", priority: 3 })).toBe(false)
  })

  test("current ID constructors expose create", () => {
    expect(Question.ID.create()).toStartWith("que_")
    expect(Pty.ID.create()).toStartWith("pty_")
  })

  test("reusable public identifiers are stable and unique", () => {
    const identifiers = [
      Agent.Color,
      FileSystem.Submatch,
      Model.Ref,
      Model.Capabilities,
      Model.Cost,
      Model.Api,
      Project.Icon,
      Project.Commands,
      Project.Time,
      Project.Info,
      Pty.Info,
      Session.ListAnchor,
    ].map((schema) => schema.ast.annotations?.identifier)

    expect(identifiers.every((identifier) => typeof identifier === "string")).toBe(true)
    expect(new Set(identifiers).size).toBe(identifiers.length)
  })

  test("current source avoids Any and mutable contract wrappers", async () => {
    const files = [...new Bun.Glob("*.ts").scanSync(new URL("../src", import.meta.url).pathname)].filter(
      (file) => !file.endsWith("-v1.ts"),
    )
    const source = await Promise.all(
      files.map((file) => Bun.file(new URL(`../src/${file}`, import.meta.url)).text()),
    ).then((values) => values.join("\n"))

    expect(source).not.toContain("Schema.Any")
    expect(source).not.toContain("Schema.mutable")
  })
})
