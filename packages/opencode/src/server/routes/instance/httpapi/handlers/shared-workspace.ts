import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
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

        const startOperation = (generation: number, operation: Effect.Effect<unknown, unknown>) =>
          Effect.gen(function* () {
            if (generation !== roomGeneration) return
            const fiber = yield* Effect.forkScoped(operation)
            operationFibers.add(fiber)
            yield* Effect.forkScoped(
              Fiber.join(fiber).pipe(
                Effect.ensuring(Effect.sync(() => operationFibers.delete(fiber))),
                Effect.catchCause(() => Effect.void),
              ),
            )
          })

        const handleClientMessage = (msg: ClientMessage): Effect.Effect<void> =>
          Effect.gen(function* () {
            if (!isMessageForRoom(msg, currentSessionID)) return
            switch (msg.type) {
              case "join": {
                const session = yield* sessionSvc.get(msg.sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
                if (!session) return

                const instance = yield* InstanceState.context
                const workspaceID = yield* InstanceState.workspaceID
                if (!sessionBelongsToRoute(session, instance, workspaceID)) return
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
                yield* startOperation(generation, promptSvc
                  .prompt({
                    sessionID: currentSessionID as SessionID,
                    agent: msg.payload.agent,
                    variant: msg.payload.variant,
                    model: modelRef(
                      msg.payload.providerID && msg.payload.modelID
                        ? `${msg.payload.providerID}/${msg.payload.modelID}`
                        : undefined,
                    ),
                     parts: (msg.payload.parts as any[] | undefined) ?? (message ? [{ type: "text", text: message }] : []),
                  })
                  .pipe(Effect.catch(() => Effect.void)))
                break
              }

              case "command":
                yield* startOperation(roomGeneration, promptSvc
                  .command({
                    sessionID: currentSessionID as SessionID,
                    command: msg.payload.command,
                    arguments: msg.payload.args,
                    agent: msg.payload.agent,
                    model: msg.payload.model,
                    variant: msg.payload.variant,
                  })
                  .pipe(Effect.catch(() => Effect.void)))
                break

              case "permissionReply": {
                const requestID = Schema.decodeUnknownOption(PermissionV1.ID)(msg.payload.requestID)
                if (Option.isNone(requestID)) return
                yield* permissionSvc
                  .reply({
                    requestID: requestID.value,
                    reply: msg.payload.response,
                    sessionID: currentSessionID as SessionID,
                    message: msg.payload.message,
                  })
                  .pipe(Effect.catchTag("Permission.NotFoundError", () => Effect.void))
                break
              }

              case "abort":
                yield* promptSvc.cancel(currentSessionID as SessionID).pipe(Effect.catch(() => Effect.void))
                break

              case "shell":
                yield* startOperation(roomGeneration, promptSvc
                  .shell({
                    sessionID: currentSessionID as SessionID,
                    command: "payload" in msg ? msg.payload.command : msg.command,
                    agent: ("payload" in msg ? msg.payload.agent : msg.agent) ?? "",
                    model: modelRef("payload" in msg ? msg.payload.model : msg.model),
                  })
                  .pipe(Effect.catch(() => Effect.void)))
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
