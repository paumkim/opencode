import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Effect, Queue, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { InstanceHttpApi } from "../api"
import { WebSocketTracker } from "../websocket-tracker"

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

type ClientMessage =
  | { type: "join"; sessionID: string }
  | { type: "prompt"; sessionID: string; payload: { message: string; modelID?: string; providerID?: string; agent?: string; variant?: string } }
  | { type: "command"; sessionID: string; payload: { command: string; args: string; agent?: string; model?: string; variant?: string } }
  | { type: "permissionReply"; sessionID: string; payload: { requestID: string; response: string; message?: string } }
  | { type: "abort"; sessionID: string }
  | { type: "shell"; sessionID: string; payload: { command: string; agent?: string; model?: string } }

function encodeEvent(event: {
  id: string
  type: string
  properties: Record<string, unknown>
}): string {
  return JSON.stringify(event)
}

function parseClientMessage(text: string): ClientMessage | undefined {
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

  const getString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

  switch (obj.type) {
    case "join":
      return { type: "join", sessionID: obj.sessionID }
    case "prompt": {
      const payload = obj.payload as Record<string, unknown> | undefined
      return {
        type: "prompt",
        sessionID: obj.sessionID,
        payload: {
          message: typeof payload?.message === "string" ? payload.message : "",
          modelID: getString(payload?.modelID),
          providerID: getString(payload?.providerID),
          agent: getString(payload?.agent),
          variant: getString(payload?.variant),
        },
      }
    }
    case "command": {
      const payload = obj.payload as Record<string, unknown> | undefined
      return {
        type: "command",
        sessionID: obj.sessionID,
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
      return {
        type: "permissionReply",
        sessionID: obj.sessionID,
        payload: {
          requestID: typeof payload?.requestID === "string" ? payload.requestID : "",
          response: typeof payload?.response === "string" ? payload.response : "once",
          message: typeof payload?.message === "string" ? payload.message : undefined,
        },
      }
    }
    case "abort":
      return { type: "abort", sessionID: obj.sessionID }
    case "shell": {
      const payload = obj.payload as Record<string, unknown> | undefined
      return {
        type: "shell",
        sessionID: obj.sessionID,
        payload: {
          command: typeof payload?.command === "string" ? payload.command : "",
          agent: getString(payload?.agent),
          model: getString(payload?.model),
        },
      }
    }
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const sharedHandlers = HttpApiBuilder.group(InstanceHttpApi, "shared", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const promptSvc = yield* SessionPrompt.Service
    const permissionSvc = yield* Permission.Service

    // Room: sessionID -> Set of WebSocket close-effectors
    const rooms = new Map<string, Set<Effect.Effect<void>>>()

    const joinRoom = (sessionID: string, closeEff: Effect.Effect<void>) =>
      Effect.sync(() => {
        let room = rooms.get(sessionID)
        if (!room) {
          room = new Set()
          rooms.set(sessionID, room)
        }
        room.add(closeEff)
      })

    const leaveRoom = (sessionID: string, closeEff: Effect.Effect<void>) =>
      Effect.sync(() => {
        const room = rooms.get(sessionID)
        if (!room) return
        room.delete(closeEff)
        if (room.size === 0) rooms.delete(sessionID)
      })

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
        const outbox = yield* Queue.unbounded<string | Socket.CloseEvent>()
        const send = (msg: string) => { Queue.offerUnsafe(outbox, msg) }

        // Writer: drain outbox
        const drain = Effect.gen(function* () {
          while (true) {
            const item = yield* Queue.take(outbox)
            yield* write(item)
            if (item instanceof Socket.CloseEvent) return
          }
        })

        // Track the current session for cleanup
        let currentSessionID: string | undefined
        let eventUnsubscribe: Effect.Effect<void> | undefined

        // Reader: parse incoming JSON messages synchronously
        const reader = socket.runRaw((message) => {
          const text = typeof message === "string" ? message : new TextDecoder().decode(message)
          const msg = parseClientMessage(text)
          if (!msg) return
          handleClientMessage(msg, send)
        })

        const handleClientMessage = (msg: ClientMessage, send: (msg: string) => void) => {
          Effect.runFork(
            Effect.gen(function* () {
              switch (msg.type) {
                case "join": {
                  // Leave previous room
                  if (currentSessionID && eventUnsubscribe) {
                    yield* eventUnsubscribe
                     yield* leaveRoom(currentSessionID, drain as Effect.Effect<void>)
                  }
                  currentSessionID = msg.sessionID
                  yield* joinRoom(msg.sessionID, drain as Effect.Effect<void>)
                  // Subscribe to events for this session
                  const instance = yield* InstanceState.context
                  const workspaceID = yield* InstanceState.workspaceID
                  const queue = yield* Queue.unbounded<{ id: string; type: string; properties: Record<string, unknown> }>()
                  const unsub = yield* events.listen((event) =>
                    Effect.sync(() => {
                      const data = event.data as Record<string, unknown>
                      if (data?.sessionID !== msg.sessionID) return
                      if (event.location?.directory !== instance.directory) return
                      if (event.location.workspaceID !== undefined && event.location.workspaceID !== workspaceID)
                        return
                      Queue.offerUnsafe(queue, {
                        id: event.id,
                        type: event.type,
                        properties: data,
                      })
                    }),
                  )
                  eventUnsubscribe = unsub

                  // Stream events to this client
                  Effect.runFork(
                    Effect.gen(function* () {
                      while (true) {
                        const event = yield* Queue.take(queue)
                        send(encodeEvent(event))
                      }
                    }).pipe(
                      Effect.catch(() => Effect.void),
                      Effect.ensuring(Effect.logInfo("shared workspace event stream ended")),
                    ),
                  )

                  send(encodeEvent({ id: "", type: "joined", properties: { sessionID: msg.sessionID } }))
                  break
                }

                case "prompt": {
                  const parts: Array<{ type: "text"; text: string }> = []
                  const message = msg.payload.message || ""
                  if (message) {
                    parts.push({ type: "text", text: message })
                  }
                  yield* promptSvc
                    .prompt({
                      sessionID: msg.sessionID as SessionID,
                      agent: msg.payload.agent,
                      variant: msg.payload.variant,
                      model: msg.payload.modelID || msg.payload.providerID
                        ? {
                            id: msg.payload.modelID || "",
                            providerID: msg.payload.providerID || "",
                          } as any
                        : undefined,
                      parts: parts as any,
                    })
                    .pipe(Effect.catch(() => Effect.void))
                  break
                }

                case "command": {
                  yield* promptSvc
                    .command({
                      sessionID: msg.sessionID as SessionID,
                      command: msg.payload.command,
                      arguments: msg.payload.args,
                      agent: msg.payload.agent,
                      model: msg.payload.model,
                      variant: msg.payload.variant,
                    })
                    .pipe(Effect.catch(() => Effect.void))
                  break
                }

                case "permissionReply": {
                  yield* permissionSvc
                    .reply({
                      requestID: msg.payload.requestID as any,
                      reply: msg.payload.response as any,
                      message: msg.payload.message,
                    })
                    .pipe(
                      Effect.catchTag("Permission.NotFoundError", () => Effect.void),
                    )
                  break
                }

                case "abort": {
                  yield* promptSvc.cancel(msg.sessionID as SessionID).pipe(Effect.catch(() => Effect.void))
                  break
                }

                case "shell": {
                  yield* promptSvc
                    .shell({
                      sessionID: msg.sessionID as SessionID,
                      command: msg.payload.command,
                      agent: msg.payload.agent ?? "",
                      model: msg.payload.model
                        ? { id: msg.payload.model, providerID: "" } as any
                        : undefined,
                    })
                    .pipe(Effect.catch(() => Effect.void))
                  break
                }
              }
            }).pipe(Effect.catch(() => Effect.void)),
          )
        }

        yield* Effect.race(drain, reader).pipe(
          Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
          Effect.ensuring(
            Effect.gen(function* () {
              if (eventUnsubscribe) yield* eventUnsubscribe
              if (currentSessionID) yield* leaveRoom(currentSessionID, drain as Effect.Effect<void>)
            }),
          ),
          Effect.orDie,
        )
        return HttpServerResponse.empty()
      }),
    )
  }),
)
