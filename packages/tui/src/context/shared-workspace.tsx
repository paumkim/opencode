import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import type { EventSource } from "./sdk"
import { useRoute } from "./route"
import { useProject } from "./project"
import { createEffect, onCleanup } from "solid-js"

export type SharedWorkspaceMessage =
  | { type: "join"; sessionID: string }
  | { type: "prompt"; sessionID: string; payload: Record<string, unknown> & { parts?: unknown[] } }
  | { type: "command"; sessionID: string; payload: { command: string; args: string; model?: string; agent?: string; variant?: string } }
  | { type: "shell"; sessionID: string; payload: { command: string; model?: string; agent?: string } }
  | { type: "permissionReply"; sessionID: string; payload: { requestID: string; response: string; message?: string } }
  | { type: "abort"; sessionID: string }

export function sharedAuthToken(headers: RequestInit["headers"]): string | undefined {
  const value = new Headers(headers).get("authorization")
  if (!value) return undefined
  const match = value.match(/^(?:Basic|Bearer)\s+(.+)$/i)
  return match?.[1] ?? value
}

let bridgeDirectory: string | undefined
let bridgeWorkspace: string | undefined
const bridgedEventHandlers = new Set<(event: { id: string; type: string; properties: Record<string, unknown> }) => void>()

function bridgeEvent(data: { id?: string; type: string; properties?: Record<string, unknown> }) {
  for (const listener of bridgedEventHandlers) {
    listener({ id: data.id ?? "", type: data.type, properties: data.properties ?? {} })
  }
}

export const { use: useSharedWorkspace, provider: SharedWorkspaceProvider, useOptional: useOptionalSharedWorkspace } = createSimpleContext({
  name: "SharedWorkspace",
  init: () => {
    const sdk = useSDK()
    const route = useRoute()
    const project = useProject()

    let ws: WebSocket | undefined
    let connected = false
    let generation = 0
    let currentSessionID: string | undefined
    let currentIdentity: string | undefined
    const listeners = new Set<(event: { id: string; type: string; properties: Record<string, unknown> }) => void>()

    function connect(sessionID: string): Promise<() => void> {
      return new Promise((resolve, reject) => {
        // The local worker transport is RPC-only and has no WebSocket endpoint.
        // Reject before mutating shared bridge state or tearing down a live connection.
        if (sdk.url === "http://opencode.internal") {
          reject(new Error("Shared workspace mode requires a WebSocket-capable server"))
          return
        }
        const identity = `${sdk.url}\u0000${sdk.directory ?? ""}\u0000${project.workspace.current() ?? ""}`
        if (ws?.readyState === WebSocket.OPEN && currentSessionID === sessionID && currentIdentity === identity) {
          resolve(() => {})
          return
        }

        // Close existing connection
        const socketGeneration = ++generation
        if (ws) {
          ws.close()
          ws = undefined
        }

        const wsUrl = new URL("/ws", sdk.url.replace(/^http/, "ws"))
    if (sdk.directory) wsUrl.searchParams.set("directory", sdk.directory)
    const workspace = project.workspace.current()
    bridgeDirectory = sdk.directory
    bridgeWorkspace = workspace
    if (workspace) wsUrl.searchParams.set("workspace", workspace)
    const auth = sharedAuthToken(sdk.headers)
    if (auth) wsUrl.searchParams.set("auth_token", auth)
    const socket = new WebSocket(wsUrl.toString())

        ws = socket
        currentSessionID = sessionID
        currentIdentity = identity
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined

        socket.onopen = () => {
          if (socketGeneration !== generation) return
          socket.send(JSON.stringify({ type: "join", sessionID }))
        }

        socket.onmessage = (event) => {
          try {
            if (socketGeneration !== generation) return
            const data = JSON.parse(event.data)
            if (data.type === "joined") {
              connected = true
              settled = true
              if (timer) clearTimeout(timer)
              timer = undefined
              resolve(() => {
                if (socketGeneration !== generation) return
                generation++
                socket.close()
                ws = undefined
                connected = false
              })
              return
            }
            const nextEvent = {
              id: data.id ?? "",
              type: data.type,
              properties: data.properties ?? {},
            }
            for (const listener of listeners) listener(nextEvent)
            bridgeEvent(data)
          } catch {
            // ignore malformed messages
          }
        }

        socket.onclose = () => {
          if (socketGeneration !== generation) return
          connected = false
          if (ws === socket) ws = undefined
          if (timer) clearTimeout(timer)
          timer = undefined
          if (!settled) {
            settled = true
            reject(new Error("WebSocket connection failed"))
          }
        }

        socket.onerror = () => {
          if (socketGeneration !== generation) return
          connected = false
          if (ws === socket) ws = undefined
          if (timer) clearTimeout(timer)
          timer = undefined
          if (!settled) {
            settled = true
            reject(new Error("WebSocket connection failed"))
          }
        }

        timer = setTimeout(() => {
          if (socketGeneration !== generation || settled) return
          settled = true
          if (ws === socket) ws = undefined
          connected = false
          socket.close()
          reject(new Error("WebSocket join timed out"))
        }, 10_000)
      })
    }

    function send(message: SharedWorkspaceMessage) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify(message))
    }

    // Auto-join when route changes to a session
    let joinCleanup: (() => void) | undefined
    createEffect(() => {
      const currentRoute = route.data
      sdk.directory
      project.workspace.current()
      let disposed = false
      onCleanup(() => {
        disposed = true
        const cleanup = joinCleanup
        joinCleanup = undefined
        cleanup?.()
      })
      if (currentRoute.type === "session" && currentRoute.sessionID) {
        connect(currentRoute.sessionID).then((cleanup) => {
          if (disposed) {
            cleanup()
            return
          }
          joinCleanup = cleanup
        }).catch(() => {
          // Connection failed, will retry on next route change
        })
      }
    })

    return {
      get connected() {
        return connected
      },
      join(sessionID: string) {
        return connect(sessionID)
      },
      subscribe(listener: (event: { id: string; type: string; properties: Record<string, unknown> }) => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      sendPrompt(sessionID: string, payload: Record<string, unknown>) {
        send({ type: "prompt", sessionID, payload })
      },
      sendCommand(sessionID: string, command: string, args: string, model?: string, agent?: string, variant?: string) {
        send({ type: "command", sessionID, payload: { command, args, model, agent, variant } })
      },
      sendShell(sessionID: string, command: string, model?: string, agent?: string) {
        send({ type: "shell", sessionID, payload: { command, model, agent } })
      },
      sendPermissionReply(sessionID: string, requestID: string, response: string, message?: string) {
        send({ type: "permissionReply", sessionID, payload: { requestID, response, message } })
      },
      sendAbort(sessionID: string) {
        send({ type: "abort", sessionID })
      },
    }
  },
})

// Create a WebSocket-based EventSource for the SDK
export function createSharedWorkspaceEventSource(url: string, options?: { directory?: string; workspace?: string; headers?: RequestInit["headers"] }): EventSource {
  return {
    subscribe: (handler) => {
      const listener = (event: { id: string; type: string; properties: Record<string, unknown> }) => {
        handler({
          directory: options?.directory ?? bridgeDirectory ?? new URL(url).pathname,
          workspace: options?.workspace ?? bridgeWorkspace,
          payload: event,
        } as any)
      }
      bridgedEventHandlers.add(listener)
      return Promise.resolve(() => bridgedEventHandlers.delete(listener))
    },
  }
}

