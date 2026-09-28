import { SessionID } from "../../src/session/schema"
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  decideJoin,
  isMessageForRoom,
  joinRefusalReason,
  sessionBelongsToRoute,
  parseClientMessage,
  type JoinLookup,
} from "../../src/server/routes/instance/httpapi/handlers/shared-workspace"

describe("shared workspace client messages", () => {
  test("accepts only documented permission replies", () => {
    for (const response of ["once", "always", "reject"] as const) {
      expect(
        parseClientMessage(
          JSON.stringify({
            type: "permissionReply",
            sessionID: SessionID.make("ses_current"),
            payload: { requestID: "per_request", response },
          }),
        ),
      ).toEqual({
        type: "permissionReply",
        sessionID: SessionID.make("ses_current"),
        payload: { requestID: "per_request", response, message: undefined },
      })
    }
  })

  test("rejects missing, non-string, and unknown permission replies", () => {
    const messages = [
      { type: "permissionReply", sessionID: SessionID.make("ses_current"), payload: { requestID: "per_request" } },
      {
        type: "permissionReply",
        sessionID: SessionID.make("ses_current"),
        payload: { requestID: "per_request", response: 1 },
      },
      {
        type: "permissionReply",
        sessionID: SessionID.make("ses_current"),
        payload: { requestID: "per_request", response: "approve" },
      },
    ]
    for (const message of messages) expect(parseClientMessage(JSON.stringify(message))).toBeUndefined()
  })

  test("authorizes control messages only against the joined room while allowing switches", () => {
    const current = parseClientMessage(JSON.stringify({ type: "abort", sessionID: SessionID.make("ses_current") }))!
    const foreign = parseClientMessage(JSON.stringify({ type: "shell", sessionID: SessionID.make("ses_foreign"), payload: { command: "pwd" } }))!
    const next = parseClientMessage(JSON.stringify({ type: "join", sessionID: SessionID.make("ses_next") }))!

    expect(isMessageForRoom(current, "ses_current")).toBe(true)
    expect(isMessageForRoom(current, undefined)).toBe(false)
    expect(isMessageForRoom(foreign, "ses_current")).toBe(false)
    expect(isMessageForRoom(next, "ses_current")).toBe(true)
  })

  test("rejects foreign-project and unscoped sessions for routed workspaces", () => {
    const context = { project: { id: "project-current" }, directory: "/current" }
    expect(sessionBelongsToRoute({ projectID: "project-current", directory: "/current", workspaceID: "workspace-a" }, context, "workspace-a")).toBe(true)
    expect(sessionBelongsToRoute({ projectID: "project-other", directory: "/current", workspaceID: "workspace-a" }, context, "workspace-a")).toBe(false)
    expect(sessionBelongsToRoute({ projectID: "project-current", directory: "/current" }, context, "workspace-a")).toBe(false)
    expect(sessionBelongsToRoute({ projectID: "project-current", directory: "/current" }, context, undefined)).toBe(true)
  })

  test("uses a bounded shared message queue contract", () => {
    // The parser must reject unknown/malformed input before queue admission.
    expect(parseClientMessage(JSON.stringify({ type: "abort", sessionID: "ses_ok" }))).toBeDefined()
    expect(parseClientMessage(JSON.stringify({ type: "abort", sessionID: "not-a-session" }))).toBeUndefined()
  })

  test("parses shell provider/model strings into a structured model", () => {
    const message = parseClientMessage(
      JSON.stringify({ type: "shell", sessionID: "ses_shell", command: "pwd", model: "opencode/model-x" }),
    )
    expect(message).toMatchObject({ type: "shell", model: "opencode/model-x" })
  })

  test("accepts top-level shell messages and rejects malformed session ids", () => {
    expect(parseClientMessage(JSON.stringify({ type: "shell", sessionID: SessionID.make("ses_shell"), command: "pwd" }))).toEqual({
      type: "shell",
      sessionID: SessionID.make("ses_shell"),
      command: "pwd",
      agent: undefined,
      model: undefined,
    })
    expect(parseClientMessage(JSON.stringify({ type: "shell", sessionID: "invalid", command: "pwd" }))).toBeUndefined()
  })

  test("preserves structured prompt parts", () => {
    const parts = [{ type: "text", text: "hello" }, { type: "file", mime: "image/png", url: "data:image/png;base64,abc" }]
    const message = parseClientMessage(
      JSON.stringify({ type: "prompt", sessionID: "ses_structured", payload: { message: "hello", parts } }),
    )
    expect(message).toMatchObject({ type: "prompt", payload: { parts } })
  })
  test("retains the body session for the current-room authorization check", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: "abort", sessionID: SessionID.make("ses_foreign") }),
      ),
    ).toEqual({ type: "abort", sessionID: SessionID.make("ses_foreign") })
    expect(
      parseClientMessage(
        JSON.stringify({ type: "shell", sessionID: SessionID.make("ses_foreign"), payload: { command: "pwd" } }),
      ),
    ).toEqual({ type: "shell", sessionID: SessionID.make("ses_foreign"), payload: { command: "pwd", agent: undefined, model: undefined } })
  })
})

describe("shared workspace join decisions", () => {
  const route = {
    context: { project: { id: "project-current" }, directory: "/current" },
    workspaceID: "workspace-a",
  }
  const local = { projectID: "project-current", directory: "/current", workspaceID: "workspace-a" } as never
  const found = (session: unknown): JoinLookup => ({ ok: true, session: session as never })

  test("reports a failed session read instead of answering a join with silence", () => {
    // The regression: the join case caught every read failure into `undefined` and returned, which
    // is the same value a session-not-found produced and the same value a still-pending success
    // could have been mistaken for. The client then waited out a ten-second timeout for a `joined`
    // frame that was never coming, and the server logged nothing.
    const outcome = decideJoin({ ok: false, notFound: false, error: new Error("database is locked") }, route)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe("read-failed")
    // The cause travels with it: "it did not work" is not a diagnosis.
    expect(outcome.detail).toContain("database is locked")
    expect(joinRefusalReason("ses_x", outcome)).toContain("database is locked")
  })

  test("keeps a missing session distinct from a failed read", () => {
    // Collapsing these is the actual bug. A client pointing at a session that was deleted is a
    // normal thing to do, and it must not be reported as the server failing to read state.
    const outcome = decideJoin({ ok: false, notFound: true }, route)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe("unknown-session")
    expect(outcome.reason).not.toBe("read-failed")
  })

  test("names a session that belongs to another workspace as a refusal, not a read failure", () => {
    const outcome = decideJoin(
      found({ projectID: "project-other", directory: "/current", workspaceID: "workspace-a" }),
      route,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe("wrong-workspace")
    expect(joinRefusalReason("ses_x", outcome)).toContain("ses_x")
  })

  test("still honours a session that is genuinely on this route", () => {
    // The other direction. A guard that refuses everything would satisfy every test above, and
    // the client would simply never see a live session again.
    const outcome = decideJoin(found(local), route)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.session).toBe(local)
  })

  test("every refusal produces a reason the client can act on", () => {
    // A refusal with an empty or vague reason is a refusal the client still cannot explain to the
    // user, so the close reason has to name the session and say what went wrong.
    for (const lookup of [
      { ok: false, notFound: true } as const,
      { ok: false, notFound: false, error: new Error("boom") } as const,
      found({ projectID: "project-other", directory: "/current", workspaceID: "workspace-a" }),
    ]) {
      const outcome = decideJoin(lookup, route)
      if (outcome.ok) throw new Error("expected a refusal")
      const reason = joinRefusalReason("ses_target", outcome)
      expect(reason).toContain("ses_target")
      expect(reason.length).toBeGreaterThan("could not join ses_target: ".length)
    }
  })
})

describe("shared workspace join wiring", () => {
  const source = readFileSync(
    new URL("../../src/server/routes/instance/httpapi/handlers/shared-workspace.ts", import.meta.url),
    "utf-8",
  )

  test("the join branch answers a refusal instead of returning silently", () => {
    // `decideJoin` is a pure function, so every test above still passes if the handler quietly
    // stopped calling it. Mounting this handler needs a live WebSocket and an instance context,
    // which is a fixture far larger than the defect, so this checks the branch directly.
    //
    // The window is the whole `join` case rather than a single line: the defect was three bare
    // returns spread across the branch, so a window that held only the `sessionSvc.get` call
    // would not have contained any of them.
    //
    // It is anchored at the handler, not at the first `case "join":` in the file. `parseClientMessage`
    // has one too, and searching from byte zero finds the parser and reports a green test that has
    // proved nothing - the first version of this test did exactly that.
    const handler = source.indexOf("const handleClientMessage")
    expect(handler).toBeGreaterThan(-1)
    const start = source.indexOf('case "join":', handler)
    const end = source.indexOf('case "prompt":', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const branch = source.slice(start, end)

    expect(branch).toContain("decideJoin(")
    expect(branch).toContain("joinRefusalReason(")
    // The old shape, verbatim. Both were `return`s that told the client nothing.
    expect(branch).not.toContain("if (!session) return")
    expect(branch).not.toContain("Effect.catchCause(() => Effect.succeed(undefined))")
  })
})
