import { expect, test } from "bun:test"
import { TerminalTitle } from "../src/terminal-title"

function data(input: Partial<TerminalTitle.Data> = {}): TerminalTitle.Data {
  return {
    session: [{ id: "parent", title: "Build status" }],
    session_status: {},
    permission: {},
    question: {},
    ...input,
  }
}

test("idle session has no indicator", () => {
  expect(TerminalTitle.session({ id: "parent", data: data(), observed: new Set() })).toEqual({
    title: "OC | Build status",
    id: "parent",
    active: false,
    indicator: "none",
  })
})

test("busy and retry statuses are working", () => {
  for (const type of ["busy", "retry"] as const) {
    expect(
      TerminalTitle.session({ id: "parent", data: data({ session_status: { parent: { type } } }), observed: new Set() })
        .indicator,
    ).toBe("working")
  }
})

test("pending permission overrides busy", () => {
  expect(
    TerminalTitle.session({
      id: "parent",
      data: data({ session_status: { parent: { type: "busy" } }, permission: { parent: [{}] } }),
      observed: new Set(),
    }).indicator,
  ).toBe("attention")
})

test("pending question overrides busy", () => {
  expect(
    TerminalTitle.session({
      id: "parent",
      data: data({ session_status: { parent: { type: "busy" } }, question: { parent: [{}] } }),
      observed: new Set(),
    }).indicator,
  ).toBe("attention")
})

test("child activity marks parent attention", () => {
  expect(
    TerminalTitle.session({
      id: "parent",
      data: data({
        session: [
          { id: "parent", title: "Build status" },
          { id: "child", title: "Child", parentID: "parent" },
        ],
        question: { child: [{}] },
      }),
      observed: new Set(),
    }).indicator,
  ).toBe("attention")
})

test("viewing a child shares its parent indicator", () => {
  const result = TerminalTitle.session({
    id: "child",
    data: data({
      session: [
        { id: "parent", title: "Build status" },
        { id: "child", title: "Child", parentID: "parent" },
      ],
      session_status: { parent: { type: "busy" } },
    }),
    observed: new Set(),
  })
  expect(result.indicator).toBe("working")
  expect(result.id).toBe("parent")
})

test("finished only after observed activity", () => {
  const observed = new Set<string>()
  const busy = data({ session_status: { parent: { type: "busy" } } })
  expect(TerminalTitle.session({ id: "parent", data: busy, observed }).indicator).toBe("working")
  observed.add("parent")
  expect(TerminalTitle.session({ id: "parent", data: data(), observed }).indicator).toBe("finished")
  expect(TerminalTitle.session({ id: "parent", data: data(), observed: new Set() }).indicator).toBe("none")
})

test("family precedence is attention, working, finished, none", () => {
  for (const target of ["parent", "child"]) {
    for (const type of ["idle", "busy", "retry"] as const) {
      for (const queue of ["permission", "question"] as const) {
        const input = data({
          session: [
            { id: "parent", title: "Build status" },
            { id: "child", parentID: "parent", title: "Child" },
          ],
          session_status: { [target]: { type } },
          [queue]: { child: [{}] },
        })
        const observed = new Set(["parent"])
        expect(TerminalTitle.session({ id: "parent", data: input, observed }).title).toBe("[!] OC | Build status")
        input[queue].child = []
        expect(TerminalTitle.session({ id: "parent", data: input, observed }).title).toBe(
          type === "idle" ? "[done] OC | Build status" : "[~] OC | Build status",
        )
      }
    }
  }
})

test("unrelated sessions and grandchildren do not affect the parent", () => {
  const input = data({
    session: [
      { id: "parent", title: "Build status" },
      { id: "child", parentID: "parent", title: "Child" },
      { id: "grandchild", parentID: "child", title: "Grandchild" },
      { id: "other", title: "Other" },
    ],
    session_status: { other: { type: "busy" }, grandchild: { type: "retry" } },
    permission: { other: [{}] },
    question: { grandchild: [{}] },
  })
  expect(TerminalTitle.session({ id: "parent", data: input, observed: new Set(["other"]) }).indicator).toBe("none")
})

test("helper does not mark activity observed itself", () => {
  const observed = new Set<string>()
  TerminalTitle.session({ id: "parent", data: data({ question: { parent: [{}] } }), observed })
  expect(observed.size).toBe(0)
})

test("40 characters remain intact and prefixes do not consume the title budget", () => {
  for (const size of [39, 40, 41]) {
    const result = TerminalTitle.session({
      id: "parent",
      data: data({ session: [{ id: "parent", title: "x".repeat(size) }] }),
      observed: new Set(["parent"]),
    })
    expect(result.title).toBe(`[done] OC | ${size > 40 ? "x".repeat(37) + "…" : "x".repeat(size)}`)
  }
})

test("long titles truncate to the existing limit", () => {
  const result = TerminalTitle.session({
    id: "parent",
    data: data({ session: [{ id: "parent", title: "12345678901234567890123456789012345678901234567890" }] }),
    observed: new Set(),
  })
  expect(result.title).toBe("OC | 1234567890123456789012345678901234567…")
})

test("default titles keep the plain base", () => {
  const result = TerminalTitle.session({
    id: "parent",
    data: data({ session: [{ id: "parent", title: "New session - 2026-07-14T10:00:00.000Z" }] }),
    observed: new Set(),
  })
  expect(result.title).toBe("OpenCode")
})

test("unknown session falls back to the app title", () => {
  expect(TerminalTitle.session({ id: "missing", data: data(), observed: new Set() })).toEqual({
    title: "OpenCode",
    id: "missing",
    active: false,
    indicator: "none",
  })
})
