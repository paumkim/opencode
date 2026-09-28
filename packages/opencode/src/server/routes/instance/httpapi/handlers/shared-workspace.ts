import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { NotFoundError } from "@/storage/storage"
import { errorMessage } from "@/util/error"
import { Effect, Fiber, Option, Queue, Schema, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { InstanceHttpApi } from "../api"
import { WebSocketTracker } from "../websocket-tracker"

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

const modelRef = (v: unknown): { providerID: ProviderV2.ID; modelID: ModelV2.ID } | undefined => {
  if (typeof v !== "string") return undefined
  const slash = v.indexOf("/")
  if (slash <= 0 || slash === v.length - 1) return undefined
  return { providerID: ProviderV2.ID.make(v.slice(0, slash)), modelID: ModelV2.ID.make(v.slice(slash + 1)) }
}

type ClientMessage =
  | { type: "join"; sessionID: SessionID }
  | { type: "prompt"; sessionID: SessionID; payload: { message: string; modelID?: string; providerID?: string; agent?: string; variant?: string; parts?: unknown[] } }
  | { type: "command"; sessionID: SessionID; payload: { command: string; args: string; agent?: string; model?: string; variant?: string } }
  | {
      type: "permissionReply"
      sessionID: SessionID
      payload: { requestID: string; response: PermissionV1.Reply; message?: string }
    }
  | { type: "abort"; sessionID: SessionID }
  | { type: "shell"; sessionID: SessionID; payload: { command: string; agent?: string; model?: string } }
  | { type: "shell"; sessionID: SessionID; command: string; agent?: string; model?: string }

function encodeEvent(event: {
  id: string
  type: string
  properties: Record<string, unknown>
}): string {
  return JSON.stringify(event)
}

export function parseClientMessage(text: string): ClientMessage | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined
  const obj = parsed as Record<string, unknown>
  if (!obj.type || typeof obj.type !== "string") return undefined
  if (!obj.sessionID || typeof obj.sessionID !== "string") return undefined

  const sessionID = Schema.decodeUnknownOption(SessionID)(obj.sessionID)
  if (Option.isNone(sessionID)) return undefined

  const getString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
  switch (obj.type) {
    case "join":
      return { type: "join", sessionID: sessionID.value }
    case "prompt": {
      const payload = obj.payload as Record<string, unknown> | undefined
      return {
        type: "prompt",
        sessionID: sessionID.value,
        payload: {
          message: typeof payload?.message === "string" ? payload.message : "",
          modelID: getString(payload?.modelID),
          providerID: getString(payload?.providerID),
           agent: getString(payload?.agent),
           variant: getString(payload?.variant),
           parts: Array.isArray(payload?.parts) ? payload.parts : undefined,
         },
      }
    }
    case "command": {
      const payload = obj.payload as Record<string, unknown> | undefined
      return {
        type: "command",
        sessionID: sessionID.value,
        payload: {
          command: typeof payload?.command === "string" ? payload.command : "",
          args: typeof payload?.args === "string" ? payload.args : "",
          agent: getString(payload?.agent),
          model: getString(payload?.model),
          variant: getString(payload?.variant),
        },
      }
    }
    case "permissionReply": {
      const payload = obj.payload as Record<string, unknown> | undefined
      if (
        typeof payload?.requestID !== "string" ||
        (payload.response !== "once" && payload.response !== "always" && payload.response !== "reject")
      ) {
        return undefined
      }
      return {
        type: "permissionReply",
        sessionID: sessionID.value,
        payload: {
          requestID: payload.requestID,
          response: payload.response,
          message: typeof payload?.message === "string" ? payload.message : undefined,
        },
      }
    }
    case "abort":
      return { type: "abort", sessionID: sessionID.value }
    case "shell": {
      const payload = obj.payload as Record<string, unknown> | undefined
      if (typeof obj.command === "string") {
        return { type: "shell", sessionID: sessionID.value, command: obj.command, agent: getString(obj.agent), model: getString(obj.model) }
      }
      if (typeof payload?.command !== "string") return undefined
      return {
        type: "shell",
        sessionID: sessionID.value,
        payload: {
          command: payload.command,
          agent: getString(payload.agent),
          model: getString(payload.model),
        },
      }
    }
    default:
      return undefined
  }
}

export function sessionBelongsToRoute(
  session: { projectID: string; directory: string; workspaceID?: string },
  context: { project: { id: string }; directory: string },
  workspaceID: string | undefined,
) {
  return (
    session.projectID === context.project.id &&
    session.directory === context.directory &&
    (workspaceID === undefined ? session.workspaceID === undefined : session.workspaceID === workspaceID)
  )
}

export function isMessageForRoom(msg: ClientMessage, currentSessionID: string | undefined) {
  return msg.type === "join" || (currentSessionID !== undefined && currentSessionID === msg.sessionID)
}

export type JoinRefusal = "unknown-session" | "read-failed" | "wrong-workspace"

/** What came back from looking the session up, with a missing session kept distinct from a failed read. */
export type JoinLookup =
  | { readonly ok: true; readonly session: Session.Info }
  | { readonly ok: false; readonly notFound: true }
  | { readonly ok: false; readonly notFound: false; readonly error: unknown }

export type JoinOutcome =
  | { readonly ok: true; readonly session: Session.Info }
  | { readonly ok: false; readonly reason: JoinRefusal; readonly detail: string }

/**
 * Decides whether a join may be honoured, and says out loud why not.
 *
 * The three refusals used to be three bare `return`s, so they were indistinguishable from one
 * another AND from a join that is merely still being processed: no `joined` frame was sent, the
 * client sat on its ten-second join timeout, and the failure surfaced as nothing at all. Worse, a
 * failed read is the server's own fault, not a client error, and it was filed under the same
 * silence as "that session does not exist".
 *
 * Split out as a pure function so the decision is testable without a socket, which is the same
 * reason `isMessageForRoom` and `sessionBelongsToRoute` live next to it.
 */
export function decideJoin(
  lookup: JoinLookup,
  route: { readonly context: { project: { id: string }; directory: string }; readonly workspaceID: string | undefined },
): JoinOutcome {
  if (!lookup.ok) {
    if (lookup.notFound) return { ok: false, reason: "unknown-session", detail: "no such session" }
    return { ok: false, reason: "read-failed", detail: `the session could not be read: ${errorMessage(lookup.error)}` }
  }
  if (!sessionBelongsToRoute(lookup.session, route.context, route.workspaceID)) {
    return {
      ok: false,
      reason: "wrong-workspace",
      detail: "that session does not belong to this project or workspace",
    }
  }
  return { ok: true, session: lookup.session }
}

/**
 * The close reason a refusal is answered with, phrased for whoever is waiting on the other end.
 */
export function joinRefusalReason(sessionID: string, refusal: Exclude<JoinOutcome, { ok: true }>): string {
  return `could not join ${sessionID}: ${refusal.detail}`
}

/** The client-message kinds that start work the server accepted but may not be able to finish. */
export type OperationName = "prompt" | "command" | "shell" | "abort" | "permissionReply"

const operationNames: readonly OperationName[] = ["prompt", "command", "shell", "abort", "permissionReply"]

export function isOperationName(value: string): value is OperationName {
  return (operationNames as readonly string[]).includes(value)
}

/**
 * The frame a client receives when work it asked for could not be carried out.
 *
 * This is deliberately *not* a socket close, unlike `joinRefusalReason`. A failed join means the
 * client is watching the wrong session and every later frame would be dropped anyway. A failed
 * operation is scoped to one message: the room is still valid, the next prompt still works, and
 * the client is sitting there with a message it typed that will never produce a reply. Closing the
 * socket would turn one lost turn into a lost session.
 */
export function operationErrorFrame(sessionID: string, operation: OperationName, error: unknown): string {
  return encodeEvent({
    id: "",
    type: "operationError",
    properties: { sessionID, operation, message: errorMessage(error) },
  })
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const sharedHandlers = HttpApiBuilder.group(InstanceHttpApi, "shared", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const promptSvc = yield* SessionPrompt.Service
    const permissionSvc = yield* Permission.Service
    const sessionSvc = yield* Session.Service

    return handlers.handleRaw(
      "ws",
      Effect.fn("SharedHttpApi.ws")(function* (ctx: {
        request: HttpServerRequest.HttpServerRequest
      }) {
        const socket = yield* Effect.orDie(ctx.request.upgrade)
        const write = yield* socket.writer

        const closeAccepted = (event: Socket.CloseEvent) =>
          socket
            .runRaw(() => Effect.void, { onOpen: write(event).pipe(Effect.catch(() => Effect.void)) })
            .pipe(
              Effect.timeout("1 second"),
              Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
              Effect.catch(() => Effect.void),
            )

        const registered = yield* WebSocketTracker.register(write(WebSocketTracker.SERVER_CLOSING_EVENT()))
        if (!registered) {
          yield* closeAccepted(WebSocketTracker.SERVER_CLOSING_EVENT())
          return HttpServerResponse.empty()
        }

        // Outbound frames flow through one queue drained by a single writer
        const outbox = yield* Queue.bounded<string | Socket.CloseEvent>(256)
        const send = (msg: string) => Effect.sync(() => {
          if (!Queue.offerUnsafe(outbox, msg)) {
            Queue.offerUnsafe(outbox, new Socket.CloseEvent(1011, "shared workspace outbound queue overflow"))
          }
        })
        const closeSocket = (reason: string) => Effect.sync(() => {
          Queue.offerUnsafe(outbox, new Socket.CloseEvent(1011, reason))
        })

        /**
         * Runs work the client asked for, and tells the client if it could not be done.
         *
         * Every operation case used to end in `Effect.catch(() => Effect.void)`, and the
         * `Fiber.join` inside `startOperation` caught the cause as well, so there were two
         * independent silences on the same path. That is not a defensive choice: the client only
         * sends a prompt over this socket when the socket is up, so there is no HTTP fallback
         * covering it, and the message simply disappears. A prompt against a session that was
         * deleted underneath it is the sharpest case - `SessionPrompt.prompt` resolves the
         * session with `Effect.orDie`, so it is a defect rather than a typed failure, and a
         * `Effect.catch` alone would not even have caught it.
         *
         * `catchCause` rather than `catch` is therefore deliberate: the operation is already
         * accepted and the client is waiting, so *every* way it can fail has to be answered.
         */
        const guardOperation = (operation: OperationName, effect: Effect.Effect<unknown, unknown>) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              send(operationErrorFrame(currentSessionID as string, operation, cause)).pipe(
                // Reporting the failure must not itself be the thing that tears the room down.
                Effect.catch(() => Effect.void),
              ),
            ),
          )

        // Writer: drain outbox
        const drain = Effect.gen(function* () {
          while (true) {
            const item = yield* Queue.take(outbox)
            yield* write(item)
            if (item instanceof Socket.CloseEvent) return
          }
        })

        // Parse frames in the callback, but enqueue their effects so processing
        // stays serialized in the connection's routed Effect context.
        const inbound = yield* Queue.bounded<ClientMessage>(256)
        const reader = socket.runRaw((message) => {
          const text = typeof message === "string" ? message : new TextDecoder().decode(message)
          const msg = parseClientMessage(text)
          if (msg) return Effect.sync(() => {
            if (!Queue.offerUnsafe(inbound, msg)) {
              Queue.offerUnsafe(outbox, new Socket.CloseEvent(1011, "shared workspace inbound queue overflow"))
            }
          })
        })

        let currentSessionID: string | undefined
        let eventUnsubscribe: Effect.Effect<void> | undefined
        let eventFiber: Fiber.Fiber<void> | undefined
        let roomGeneration = 0
        const operationFibers = new Set<Fiber.Fiber<unknown, unknown>>()

        const leaveCurrentRoom = Effect.gen(function* () {
          roomGeneration++
          for (const fiber of operationFibers) yield* Fiber.interrupt(fiber)
          operationFibers.clear()
          if (eventFiber) {
            yield* Fiber.interrupt(eventFiber)
            eventFiber = undefined
          }
          if (eventUnsubscribe) {
            yield* eventUnsubscribe
            eventUnsubscribe = undefined
          }
          currentSessionID = undefined
        }) as Effect.Effect<void>

        const startOperation = (generation: number, name: OperationName, effect: Effect.Effect<unknown, unknown>) =>
          Effect.gen(function* () {
            if (generation !== roomGeneration) return
            const fiber = yield* Effect.forkScoped(guardOperation(name, effect))
            operationFibers.add(fiber)
            yield* Effect.forkScoped(
              Fiber.join(fiber).pipe(
                Effect.ensuring(Effect.sync(() => operationFibers.delete(fiber))),
                // A guarded operation cannot fail, so this only catches the guard itself breaking -
                // and swallowing that would be the same defect one level up, so it is reported with
                // the same operation name the client sent.
                Effect.catchCause((cause) => send(operationErrorFrame(currentSessionID as string, name, cause))),
              ),
            )
          })

        const handleClientMessage = (msg: ClientMessage): Effect.Effect<void> =>
          Effect.gen(function* () {
            if (!isMessageForRoom(msg, currentSessionID)) return
            switch (msg.type) {
              case "join": {
                // A failed read and a refusal are not the same thing, and neither is a success
                // that has not happened yet. All three used to be a bare `return`, which sent the
                // client nothing and left it to time out with no idea what had happened.
                const instance = yield* InstanceState.context
                const workspaceID = yield* InstanceState.workspaceID
                const lookup = yield* sessionSvc.get(msg.sessionID).pipe(
                  Effect.map((session): JoinLookup => ({ ok: true, session })),
                  Effect.catch(
                    (error): Effect.Effect<JoinLookup> =>
                      Effect.succeed(
                        NotFoundError.isInstance(error)
                          ? { ok: false, notFound: true }
                          : { ok: false, notFound: false, error },
                      ),
                  ),
                  // `Effect.catch` does not see a defect, and a session read that dies rather
                  // than fails used to be caught by the same blanket `catchCause` as everything
                  // else. Route it to the same refusal instead of losing it.
                  Effect.catchCause((cause) => Effect.succeed({ ok: false, notFound: false, error: cause } as const)),
                )
                const outcome = decideJoin(lookup, { context: instance, workspaceID })
                if (!outcome.ok) {
                  if (outcome.reason === "read-failed") {
                    // The server's own fault, so it belongs in the log and not only in the close
                    // reason the client sees. A wrong-workspace refusal is an ordinary client
                    // error and would only be noise here.
                    yield* Effect.logError("shared workspace join read failed", {
                      sessionID: msg.sessionID,
                      reason: outcome.detail,
                    })
                  }
                  yield* closeSocket(joinRefusalReason(msg.sessionID, outcome))
                  break
                }
                const session = outcome.session
                const sessionID = msg.sessionID
                yield* leaveCurrentRoom
                const queue = yield* Queue.bounded<{
                  id: string
                  type: string
                  properties: Record<string, unknown>
                }>(256)
                eventUnsubscribe = yield* events.listen((event) =>
                  Effect.gen(function* () {
                    const data = event.data as Record<string, unknown>
                    if (data?.sessionID !== msg.sessionID) return
                    if (event.location?.directory !== instance.directory) return
                    if (event.location.workspaceID !== undefined && event.location.workspaceID !== workspaceID) return
                     const accepted = Queue.offerUnsafe(queue, { id: event.id, type: event.type, properties: data })
                     if (!accepted) yield* closeSocket("shared workspace event queue overflow")
                  }),
                )
                currentSessionID = msg.sessionID
                eventFiber = yield* Effect.forkScoped(
                  Effect.gen(function* () {
                    while (true) {
                      const event = yield* Queue.take(queue)
                        yield* send(encodeEvent(event)).pipe(Effect.catch(() => Effect.void))
                    }
                  }).pipe(Effect.catchCause(() => Effect.void)),
                )
                yield* send(encodeEvent({ id: "", type: "joined", properties: { sessionID: msg.sessionID } }))
                break
              }

              case "prompt": {
                const generation = roomGeneration
                const message = msg.payload.message
                yield* startOperation(
                  generation,
                  "prompt",
                  promptSvc.prompt({
                    sessionID: currentSessionID as SessionID,
                    agent: msg.payload.agent,
                    variant: msg.payload.variant,
                    model: modelRef(
                      msg.payload.providerID && msg.payload.modelID
                        ? `${msg.payload.providerID}/${msg.payload.modelID}`
                        : undefined,
                    ),
                     parts: (msg.payload.parts as any[] | undefined) ?? (message ? [{ type: "text", text: message }] : []),
                  }),
                )
                break
              }

              case "command":
                yield* startOperation(
                  roomGeneration,
                  "command",
                  promptSvc.command({
                    sessionID: currentSessionID as SessionID,
                    command: msg.payload.command,
                    arguments: msg.payload.args,
                    agent: msg.payload.agent,
                    model: msg.payload.model,
                    variant: msg.payload.variant,
                  }),
                )
                break

              case "permissionReply": {
                const requestID = Schema.decodeUnknownOption(PermissionV1.ID)(msg.payload.requestID)
                if (Option.isNone(requestID)) return
                // A permission that no longer exists is an ordinary race - the user answered a
                // dialog that had already gone - so it stays quiet. Anything else leaves the agent
                // blocked on a tool the user believes they approved, which is not tolerable to be
                // silent about.
                yield* guardOperation(
                  "permissionReply",
                  permissionSvc
                    .reply({
                      requestID: requestID.value,
                      reply: msg.payload.response,
                      sessionID: currentSessionID as SessionID,
                      message: msg.payload.message,
                    })
                    .pipe(Effect.catchTag("Permission.NotFoundError", () => Effect.void)),
                )
                break
              }

              case "abort":
                yield* guardOperation("abort", promptSvc.cancel(currentSessionID as SessionID))
                break

              case "shell":
                yield* startOperation(
                  roomGeneration,
                  "shell",
                  promptSvc.shell({
                    sessionID: currentSessionID as SessionID,
                    command: "payload" in msg ? msg.payload.command : msg.command,
                    agent: ("payload" in msg ? msg.payload.agent : msg.agent) ?? "",
                    model: modelRef("payload" in msg ? msg.payload.model : msg.model),
                  }),
                )
                break
            }
          }) as Effect.Effect<void>

        const actor = Effect.gen(function* () {
          while (true) yield* handleClientMessage(yield* Queue.take(inbound))
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError("shared workspace message actor failed", { cause })
              yield* closeSocket("shared workspace actor failed")
            }),
          ),
        )
        const actorFiber = yield* Effect.forkScoped(
          Effect.raceFirst(actor, Effect.never).pipe(Effect.catchCause(() => Effect.void)),
        )

        yield* Effect.race(drain, reader).pipe(
          Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Fiber.interrupt(actorFiber)
              yield* leaveCurrentRoom
            }),
          ),
          Effect.orDie,
        )
        return HttpServerResponse.empty()
      }),
    )
  }),
)
