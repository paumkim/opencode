import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import * as LSPClient from "./client"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import * as LSPServer from "./server"
import { Config } from "@/config/config"
import { Process } from "@/util/process"
import { spawn as lspspawn } from "./launch"
import { errorMessage } from "@/util/error"
import { Effect, Layer, Context, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { containsPath } from "@/project/instance-context"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LspEvent } from "@opencode-ai/schema/lsp-event"

export const Event = LspEvent

const Position = Schema.Struct({
  line: NonNegativeInt,
  character: NonNegativeInt,
})

export const Range = Schema.Struct({
  start: Position,
  end: Position,
}).annotate({ identifier: "Range" })
export type Range = typeof Range.Type

export const Symbol = Schema.Struct({
  name: Schema.String,
  kind: NonNegativeInt,
  location: Schema.Struct({
    uri: Schema.String,
    range: Range,
  }),
}).annotate({ identifier: "Symbol" })
export type Symbol = typeof Symbol.Type

export const DocumentSymbol = Schema.Struct({
  name: Schema.String,
  detail: Schema.optional(Schema.String),
  kind: NonNegativeInt,
  range: Range,
  selectionRange: Range,
}).annotate({ identifier: "DocumentSymbol" })
export type DocumentSymbol = typeof DocumentSymbol.Type

export const Status = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "error"]),
}).annotate({ identifier: "LSPStatus" })
export type Status = typeof Status.Type

enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

const kinds = [
  SymbolKind.Class,
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Interface,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Struct,
  SymbolKind.Enum,
]

const filterExperimentalServers = (servers: Record<string, LSPServer.Info>, flags: RuntimeFlags.Info) => {
  if (flags.experimentalLspTy) {
    if (servers["pyright"]) {
      delete servers["pyright"]
    }
  } else {
    if (servers["ty"]) {
      delete servers["ty"]
    }
  }
}

type LocInput = { file: string; line: number; character: number }

interface State {
  clients: LSPClient.Info[]
  servers: Record<string, LSPServer.Info>
  broken: Set<string>
  spawning: Map<string, Promise<LSPClient.Info | undefined>>
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Status[]>
  readonly hasClients: (file: string) => Effect.Effect<boolean>
  readonly touchFile: (input: string, diagnostics?: "document" | "full") => Effect.Effect<void>
  readonly diagnostics: () => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
  readonly hover: (input: LocInput) => Effect.Effect<any>
  readonly definition: (input: LocInput) => Effect.Effect<any[]>
  readonly references: (input: LocInput) => Effect.Effect<any[]>
  readonly implementation: (input: LocInput) => Effect.Effect<any[]>
  readonly documentSymbol: (uri: string) => Effect.Effect<(DocumentSymbol | Symbol)[]>
  readonly workspaceSymbol: (query: string) => Effect.Effect<Symbol[]>
  readonly prepareCallHierarchy: (input: LocInput) => Effect.Effect<any[]>
  readonly incomingCalls: (input: LocInput) => Effect.Effect<any[]>
  readonly outgoingCalls: (input: LocInput) => Effect.Effect<any[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LSP") {}

/**
 * Turns a failed LSP request into a defect carrying the reason, rather than
 * an empty result.
 *
 * These methods back the agent tools in src/tool/lsp.ts, which answer
 * `No results found for <operation>` whenever the result comes back empty.
 * So catching to `[]` meant a crashed, hung or erroring language server was
 * reported to the model as "this symbol has no references" or "this file has
 * no symbols" — a confident falsehood about the user's own code, which the
 * model then reasons about and acts on, for instance concluding that a
 * function is unused and editing accordingly.
 *
 * The reason matters as much as the failure: a server that does not
 * implement a request answers with a JSON-RPC method-not-found error, and
 * the model can do something correct with that, unlike with a silent empty
 * list.
 *
 * The same tool function already surfaces "No LSP server available for this
 * file type." as a real error, so a failed request belongs on that path
 * rather than being laundered into an answer.
 */
/**
 * Describes a rejected LSP request well enough to be worth showing.
 *
 * `String(error)` is useless for the two shapes that actually arrive: a plain
 * object becomes literally "[object Object]", and a JSON-RPC error — which is
 * what a server sends when it does not implement a method, and the case where
 * the reason matters most — carries its detail on `message`.
 */
const describeLspError = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  if (typeof error === "string" && error) return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

export const requestOrFail = <T>(method: string, request: Promise<T>): Promise<T> =>
  request.catch((error) => {
    throw new Error(`LSP ${method} request failed: ${describeLspError(error)}`)
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("LSP.state")(function* (ctx) {
        const cfg = yield* config.get()

        const servers: Record<string, LSPServer.Info> = {}

        if (!cfg.lsp) {
          yield* Effect.logInfo("all LSPs are disabled")
        } else {
          for (const server of Object.values(LSPServer)) {
            servers[server.id] = server
          }

          filterExperimentalServers(servers, flags)

          if (cfg.lsp !== true) {
            for (const [name, item] of Object.entries(cfg.lsp)) {
              const existing = servers[name]
              if (item.disabled) {
                yield* Effect.logInfo(`LSP server ${name} is disabled`)
                delete servers[name]
                continue
              }
              servers[name] = {
                ...existing,
                id: name,
                root: existing?.root ?? (async (_file, ctx) => ctx.directory),
                extensions: item.extensions ?? existing?.extensions ?? [],
                spawn: async (root) => ({
                  process: lspspawn(item.command[0], item.command.slice(1), {
                    cwd: root,
                    env: { ...process.env, ...item.env },
                  }),
                  initialization: item.initialization,
                }),
              }
            }
          }

          yield* Effect.logInfo("enabled LSP servers", {
            serverIds: Object.values(servers)
              .map((server) => server.id)
              .join(", "),
          })
        }

        const s: State = {
          clients: [],
          servers,
          broken: new Set(),
          spawning: new Map(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await Promise.all(s.clients.map((client) => client.shutdown()))
          }),
        )

        return s
      }),
    )

    const getClients = Effect.fnUntraced(function* (file: string) {
      const ctx = yield* InstanceState.context
      if (!containsPath(file, ctx)) return [] as LSPClient.Info[]
      const s = yield* InstanceState.get(state)
      const clients = yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        const result: LSPClient.Info[] = []
        let updated = 0

        async function schedule(server: LSPServer.Info, root: string, key: string) {
          const handle = await server
            .spawn(root, ctx, flags)
            .then((value) => {
              if (!value) s.broken.add(key)
              return value
            })
            .catch(() => {
              s.broken.add(key)
              return undefined
            })

          if (!handle) return undefined
          const client = await LSPClient.create({
            serverID: server.id,
            server: handle,
            root,
            directory: ctx.directory,
            instance: ctx,
          }).catch(async () => {
            s.broken.add(key)
            await Process.stop(handle.process)
            return undefined
          })

          if (!client) return undefined

          const existing = s.clients.find((x) => x.root === root && x.serverID === server.id)
          if (existing) {
            await Process.stop(handle.process)
            return existing
          }

          s.clients.push(client)
          return client
        }

        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue

          const root = await server.root(file, ctx)
          if (!root) continue
          if (s.broken.has(root + server.id)) continue

          const match = s.clients.find((x) => x.root === root && x.serverID === server.id)
          if (match) {
            result.push(match)
            continue
          }

          const inflight = s.spawning.get(root + server.id)
          if (inflight) {
            const client = await inflight
            if (!client) continue
            result.push(client)
            continue
          }

          const task = schedule(server, root, root + server.id)
          s.spawning.set(root + server.id, task)

          task.finally(() => {
            if (s.spawning.get(root + server.id) === task) {
              s.spawning.delete(root + server.id)
            }
          })

          const client = await task
          if (!client) continue

          result.push(client)
          updated++
        }

        return { result, updated }
      })
      yield* Effect.forEach(Array.from({ length: clients.updated }), () => events.publish(Event.Updated, {}), {
        discard: true,
      })
      return clients.result
    })

    const run = Effect.fnUntraced(function* <T>(file: string, fn: (client: LSPClient.Info) => Promise<T>) {
      const clients = yield* getClients(file)
      return yield* Effect.promise(() => Promise.all(clients.map((x) => fn(x))))
    })

    const runAll = Effect.fnUntraced(function* <T>(fn: (client: LSPClient.Info) => Promise<T>) {
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(() => Promise.all(s.clients.map((x) => fn(x))))
    })

    const init = Effect.fn("LSP.init")(function* () {
      yield* InstanceState.get(state)
    })

    const status = Effect.fn("LSP.status")(function* () {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      const result: Status[] = []
      for (const client of s.clients) {
        result.push({
          id: client.serverID,
          name: s.servers[client.serverID].id,
          root: path.relative(ctx.directory, client.root),
          status: "connected",
        })
      }
      return result
    })

    const hasClients = Effect.fn("LSP.hasClients")(function* (file: string) {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue
          const root = await server.root(file, ctx)
          if (!root) continue
          if (s.broken.has(root + server.id)) continue
          return true
        }
        return false
      })
    })

    const touchFile = Effect.fn("LSP.touchFile")(function* (input: string, diagnostics?: "document" | "full") {
      yield* Effect.logInfo("touching file", { file: input })
      const clients = yield* getClients(input)
      // Per-client, not `Promise.all(...).catch(() => {})`: see openEveryClient for why.
      yield* Effect.promise(() => openEveryClient(clients, input, diagnostics, console.error))
    })

    const diagnostics = Effect.fn("LSP.diagnostics")(function* () {
      const results: Record<string, LSPClient.Diagnostic[]> = {}
      const all = yield* runAll(async (client) => client.diagnostics)
      for (const result of all) {
        for (const [p, diags] of result.entries()) {
          const arr = results[p] || []
          arr.push(...diags)
          results[p] = arr
        }
      }
      return results
    })

    const hover = Effect.fn("LSP.hover")(function* (input: LocInput) {
      return yield* run(input.file, (client) =>
        requestOrFail(
          "hover",
          client.connection.sendRequest("textDocument/hover", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          }),
        ),
      )
    })

    const definition = Effect.fn("LSP.definition")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        requestOrFail(
          "goToDefinition",
          client.connection.sendRequest("textDocument/definition", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          }),
        ),
      )
      return results.flat().filter(Boolean)
    })

    const references = Effect.fn("LSP.references")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        requestOrFail(
          "findReferences",
          client.connection.sendRequest("textDocument/references", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
            context: { includeDeclaration: true },
          }),
        ),
      )
      return results.flat().filter(Boolean)
    })

    const implementation = Effect.fn("LSP.implementation")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        requestOrFail(
          "goToImplementation",
          client.connection.sendRequest("textDocument/implementation", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          }),
        ),
      )
      return results.flat().filter(Boolean)
    })

    const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string) {
      const file = fileURLToPath(uri)
      const results = yield* run(file, (client) =>
        requestOrFail(
          "documentSymbol",
          client.connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }),
        ),
      )
      return (results.flat() as (DocumentSymbol | Symbol)[]).filter(Boolean)
    })

    const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string) {
      const results = yield* runAll((client) =>
        requestOrFail("workspaceSymbol", client.connection.sendRequest<Symbol[]>("workspace/symbol", { query })).then(
          (result) => result.filter((x) => kinds.includes(x.kind)).slice(0, 10),
        ),
      )
      return results.flat()
    })

    const prepareCallHierarchy = Effect.fn("LSP.prepareCallHierarchy")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        requestOrFail(
          "prepareCallHierarchy",
          client.connection.sendRequest("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          }),
        ),
      )
      return results.flat().filter(Boolean)
    })

    const callHierarchyRequest = Effect.fnUntraced(function* (
      input: LocInput,
      direction: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
    ) {
      const results = yield* run(input.file, async (client) => {
        const items = await requestOrFail(
          direction === "callHierarchy/incomingCalls" ? "incomingCalls" : "outgoingCalls",
          client.connection.sendRequest<unknown[] | null>("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          }),
        )
        if (!items?.length) return []
        return requestOrFail(direction, client.connection.sendRequest(direction, { item: items[0] }))
      })
      return results.flat().filter(Boolean)
    })

    const incomingCalls = Effect.fn("LSP.incomingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/incomingCalls")
    })

    const outgoingCalls = Effect.fn("LSP.outgoingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/outgoingCalls")
    })

    return Service.of({
      init,
      status,
      hasClients,
      touchFile,
      diagnostics,
      hover,
      definition,
      references,
      implementation,
      documentSymbol,
      workspaceSymbol,
      prepareCallHierarchy,
      incomingCalls,
      outgoingCalls,
    })
  }),
)

export * as Diagnostic from "./diagnostic"

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, RuntimeFlags.node, FSUtil.node, EventV2Bridge.node],
})

export * as LSP from "./lsp"

/**
 * Opens `file` on one client and optionally waits for its diagnostics.
 *
 * Split out of `touchFile`'s loop so a rejection is attributable to the client that produced it -
 * which server failed is the only thing that makes such a failure actionable, and the old
 * `Promise.all(...).catch(() => {})` discarded it along with every other client's results.
 */
async function openAndWait(client: LSPClient.Info, file: string, mode: "document" | "full" | undefined) {
  const after = Date.now()
  const version = await client.notify.open({ path: file })
  if (!mode) return undefined
  return client.waitForDiagnostics({ path: file, version, mode, after })
}

/**
 * Opens `file` on every client, isolating and reporting per-client failures.
 *
 * The isolation is the point, and the old `Promise.all(...).catch(() => {})` got it wrong twice over.
 * The `.catch` discarded the reason, and because it wrapped the `all` rather than each entry, a
 * single client whose `didOpen` failed took down the results of every client that had succeeded. A
 * file watched by three language servers where one is down produced no diagnostics at all, and
 * `tool/write.ts` then reports plain "Wrote file successfully." - the agent is told the file is clean
 * because one server failed to open it. That is the same failure mode as the LSP tool answering "No
 * results found for ..." on a request it could not make, and the same fix: report, and let the rest
 * through.
 *
 * `report` is a parameter so the failure path is observable; `open` is a parameter so a test can make
 * exactly one client fail without standing up a language server.
 */
export async function openEveryClient(
  clients: readonly LSPClient.Info[],
  file: string,
  mode: "document" | "full" | undefined,
  report: (message: string) => void,
  open: (client: LSPClient.Info, file: string, mode: "document" | "full" | undefined) => Promise<unknown> = (
    client,
    target,
    diagnostics,
  ) => openAndWait(client, target, diagnostics),
) {
  // Each entry maps a success to `undefined` and a failure to a tagged record, so the two are told
  // apart by the mapping rather than by inspecting a client's payload. Deciding "did this fail?" by
  // looking for a field named `error` would report a perfectly good result carrying one as a
  // failure - which is how a fix starts manufacturing noise. The success value is otherwise unused
  // here: `openAndWait` returns the client's diagnostics payload, and `touchFile` only needs the
  // side effect of having asked for them.
  const results = await Promise.all(
    clients.map((client) =>
      open(client, file, mode).then(
        () => undefined,
        (error: unknown) => ({ client, error }),
      ),
    ),
  )
  for (const result of results) {
    if (!result) continue
    report(
      `[lsp] ${result.client.serverID} failed to open ${file}, so its diagnostics for this file are missing: ${errorMessage(result.error)}`,
    )
  }
}
