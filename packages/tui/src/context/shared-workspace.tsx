import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import type { EventSource } from "./sdk"
import { useRoute } from "./route"
import { useArgs } from "./args"
import { createEffect } from "solid-js"

export type SharedWorkspaceMessage =
  | { type: "join"; sessionID: string }
  | { type: "prompt"; sessionID: string; payload: Record<string, unknown> }
  | { type: "command"; sessionID: string; payload: { command: string; args: string } }
  | { type: "permissionReply"; sessionID: string; payload: { requestID: string; response: string; message?: string } }
  | { type: "abort"; sessionID: string }

export const { use: useSharedWorkspace, provider: SharedWorkspaceProvider, useOptional: useOptionalSharedWorkspace } = createSimpleContext({
  name: "SharedWorkspace",
  init: () => {
    const sdk = useSDK()
    const route = useRoute()

    let ws: WebSocket | undefined
    let connected = false
    let currentSessionID: string | undefined
    const listeners = new Set<(event: { id: string; type: string; properties: Record<string, unknown> }) => void>()

    function connect(sessionID: string): Promise<() => void> {
      return new Promise((resolve, reject) => {
        if (ws?.readyState === WebSocket.OPEN && currentSessionID === sessionID) {
          resolve(() => {})
          return
        }

        // Close existing connection
        if (ws) {
          ws.close()
          ws = undefined
        }

        const wsUrl = new URL("/ws", sdk.url.replace(/^http/, "ws"))
        const socket = new WebSocket(wsUrl.toString())
        ws = socket
        currentSessionID = sessionID

        socket.onopen = () => {
          connected = true
          // Join the session room
          socket.send(JSON.stringify({ type: "join", sessionID }))
        }

        socket.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            if (data.type === "joined") return
            for (const listener of listeners) {
              listener({
                id: data.id ?? "",
                type: data.type,
                properties: data.properties ?? {},
              })
            }
          } catch {
            // ignore malformed messages
          }
        }

        socket.onclose = () => {
          connected = false
          ws = undefined
        }

        socket.onerror = () => {
          connected = false
          ws = undefined
          reject(new Error("WebSocket connection failed"))
        }

        // Wait for connection to open
        const checkOpen = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            clearInterval(checkOpen)
            resolve(() => {
              ws?.close()
              ws = undefined
              connected = false
            })
          }
          if (ws?.readyState === WebSocket.CLOSED || ws?.readyState === WebSocket.CLOSING) {
            clearInterval(checkOpen)
            reject(new Error("WebSocket connection failed"))
          }
        }, 100)
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
      if (currentRoute.type === "session" && currentRoute.sessionID) {
        joinCleanup?.()
        connect(currentRoute.sessionID).then((cleanup) => {
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
      sendCommand(sessionID: string, command: string, args: string) {
        send({ type: "command", sessionID, payload: { command, args } })
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
export function createSharedWorkspaceEventSource(url: string): EventSource {
  return {
    subscribe: (handler) => {
      const wsUrl = new URL("/ws", url.replace(/^http/, "ws"))
      const socket = new WebSocket(wsUrl.toString())
      let currentSessionID: string | undefined
      let joined = false

      socket.onopen = () => {
        // Will join when we receive the first join message from the app
      }

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === "joined") {
            joined = true
            return
          }
          // Convert to GlobalEvent format
          handler({
            type: data.type,
            properties: data.properties ?? {},
            time: { created: Date.now() },
            id: data.id,
          } as any)
        } catch {
          // ignore malformed messages
        }
      }

      socket.onclose = () => {}
      socket.onerror = () => {}

      // Expose a method to join a session room
      const join = (sessionID: string) => {
        currentSessionID = sessionID
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "join", sessionID }))
        }
      }

      // Expose a method to send messages
      const send = (message: Record<string, unknown>) => {
        if (socket.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify(message))
      }

      return Promise.resolve(() => {
        socket.close()
      })
    },
  }
}

