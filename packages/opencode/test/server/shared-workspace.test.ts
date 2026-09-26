import { SessionID } from "../../src/session/schema"
import { describe, expect, test } from "bun:test"
import {
  isMessageForRoom,
  sessionBelongsToRoute,
  parseClientMessage,
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
