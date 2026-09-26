import { createConnection } from "net"
import { createServer } from "http"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH, parseRedirectUri } from "./oauth-provider"

const OAUTH_CALLBACK_HOST = "127.0.0.1"

interface CallbackServer {
  server: ReturnType<typeof createServer>
  port: number
  path: string
  owners: Set<symbol>
  starting?: Promise<void>
}

interface PendingAuth {
  resolve: (code: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  owner: symbol
}

const servers = new Map<string, CallbackServer>()
const pendingAuths = new Map<string, PendingAuth>()
const mcpNameToOwner = new Map<string, symbol>()

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

function key(port: number, path: string) {
  return `${port}:${path}`
}

function handleRequest(listener: CallbackServer, req: import("http").IncomingMessage, res: import("http").ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost:${listener.port}`)

  if (url.pathname !== listener.path) {
    res.writeHead(404)
    res.end("Not found")
    return
  }

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")
  const errorDescription = url.searchParams.get("error_description")

  // Enforce state parameter presence
  if (!state) {
    const errorMsg = "Missing required state parameter - potential CSRF attack"
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(OauthCallbackPage.error(errorMsg, { provider: "MCP" }))
    return
  }

  if (error) {
    const errorMsg = errorDescription || error
    if (pendingAuths.has(state)) {
      const pending = pendingAuths.get(state)!
      clearTimeout(pending.timeout)
      pendingAuths.delete(state)
      cleanupOwnerIndex(pending.owner)
      pending.reject(new Error(errorMsg))
      release(pending.owner)
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(OauthCallbackPage.error(errorMsg, { provider: "MCP" }))
    return
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(OauthCallbackPage.error("No authorization code provided", { provider: "MCP" }))
    return
  }

  // Validate state parameter
  if (!pendingAuths.has(state)) {
    const errorMsg = "Invalid or expired state parameter - potential CSRF attack"
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(OauthCallbackPage.error(errorMsg, { provider: "MCP" }))
    return
  }

  const pending = pendingAuths.get(state)!

  clearTimeout(pending.timeout)
  pendingAuths.delete(state)
  cleanupOwnerIndex(pending.owner)
  pending.resolve(code)
  release(pending.owner)

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(OauthCallbackPage.success({ provider: "MCP" }))
}

async function closeListener(listener: CallbackServer) {
  if (!listener.server.listening) return
  await new Promise<void>((resolve) => listener.server.close(() => resolve()))
}

function cleanupOwnerIndex(owner: symbol) {
  for (const [name, value] of mcpNameToOwner) if (value === owner) mcpNameToOwner.delete(name)
}

function release(owner: symbol) {
  for (const listener of servers.values()) listener.owners.delete(owner)
  for (const listener of servers.values()) {
    if (listener.owners.size === 0) {
      servers.delete(key(listener.port, listener.path))
      void closeListener(listener)
    }
  }
}

export async function ensureRunning(redirectUri?: string, mcpName?: string): Promise<symbol> {
  const { port, path } = parseRedirectUri(redirectUri)
  const id = key(port, path)
  const owner = Symbol(id)
  const existing = servers.get(id)
  if (existing) {
    if (existing.starting) await existing.starting
    existing.owners.add(owner)
    if (mcpName) mcpNameToOwner.set(mcpName, owner)
    return owner
  }

  const listener: CallbackServer = {
    server: createServer((req, res) => handleRequest(listener, req, res)),
    port,
    path,
    owners: new Set([owner]),
  }
  const starting = new Promise<void>((resolve, reject) => {
    listener.server.once("error", reject)
    listener.server.listen(port, OAUTH_CALLBACK_HOST, () => {
      listener.server.removeListener("error", reject)
      resolve()
    })
  })
  listener.starting = starting
  servers.set(id, listener)
  try {
    await starting
    listener.starting = undefined
    // The only 'error' listener above is scoped to the startup race. Keep a
    // permanent listener on the running server: an unhandled 'error' event on
    // an EventEmitter throws and would crash the whole process.
    listener.server.on("error", () => {})
    if (mcpName) mcpNameToOwner.set(mcpName, owner)
    return owner
  } catch (error) {
    if (servers.get(id) === listener) servers.delete(id)
    listener.owners.clear()
    throw error
  }
}

export function waitForCallback(oauthState: string, mcpName?: string, owner?: symbol): Promise<string> {
  const resolvedOwner = owner ?? [...servers.values()].find((listener) => listener.owners.size > 0)?.owners.values().next().value
  if (!resolvedOwner) return Promise.reject(new Error("OAuth callback server is not running"))
  owner = resolvedOwner
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAuths.get(oauthState)?.owner !== owner) return
      pendingAuths.delete(oauthState)
      cleanupOwnerIndex(owner)
      reject(new Error("OAuth callback timeout - authorization took too long"))
      release(owner)
    }, CALLBACK_TIMEOUT_MS)
    pendingAuths.set(oauthState, { resolve, reject, timeout, owner: resolvedOwner })
    if (mcpName) mcpNameToOwner.set(mcpName, owner)
  })
}

export async function cancelPending(mcpName: string): Promise<void> {
  const owner = mcpNameToOwner.get(mcpName)
  if (!owner) return
  for (const [state, pending] of pendingAuths) if (pending.owner === owner) {
    clearTimeout(pending.timeout)
    pendingAuths.delete(state)
    pending.reject(new Error("Authorization cancelled"))
  }
  cleanupOwnerIndex(owner)
  release(owner)
}

export async function isPortInUse(port: number = OAUTH_CALLBACK_PORT): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1")
    socket.on("connect", () => { socket.destroy(); resolve(true) })
    socket.on("error", () => resolve(false))
  })
}

export async function stop(): Promise<void> {
  const listeners = [...servers.values()]
  servers.clear()
  await Promise.all(listeners.map(closeListener))
  for (const pending of pendingAuths.values()) {
    clearTimeout(pending.timeout)
    pending.reject(new Error("OAuth callback server stopped"))
  }
  pendingAuths.clear()
  mcpNameToOwner.clear()
}

export function isRunning(): boolean {
  return [...servers.values()].some((listener) => listener.server.listening)
}

export * as McpOAuthCallback from "./oauth-callback"
