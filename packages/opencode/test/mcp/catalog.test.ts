import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "@/mcp/catalog"
import { Effect } from "effect"

const options = { toolCallId: "call_mcp", abortSignal: new AbortController().signal } as any

function clientReturning(result: unknown) {
  return {
    callTool: async () => result,
  } as unknown as Client
}

function mcpTool() {
  return {
    name: "screenshot",
    description: "Take a screenshot",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  } as any
}

describe("McpCatalog.convertTool", () => {
  test("preserves content when structuredContent is also present", async () => {
    const content = [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }]
    const structuredContent = { image: { mimeType: "image/png", data: "AAAA" } }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content, structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({ content, structuredContent })
  })

  test("falls back to structuredContent only when content is absent", async () => {
    const structuredContent = { results: [{ title: "one" }] }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content: [], structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    })
  })
})

test("preserves output schema validation across paginated tool discovery", async () => {
  const server = new Server({ name: "pagination", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, ({ params }) =>
    Promise.resolve(
      params?.cursor === "page-2"
        ? {
            tools: [
              {
                name: "second",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "number" } },
                  required: ["value"],
                },
              },
            ],
          }
        : {
            tools: [
              {
                name: "first",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
            nextCursor: "page-2",
          },
    ),
  )
  server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
    Promise.resolve({
      content: [],
      structuredContent: { value: params.name === "first" ? 42 : 1 },
    }),
  )

  const client = new Client({ name: "pagination-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  try {
    const listed = await Effect.runPromise(McpCatalog.defs(client, "pagination"))
    expect(listed.error).toBeUndefined()
    expect(listed.tools?.map((tool) => tool.name)).toEqual(["first", "second"])
    await expect(client.callTool({ name: "first", arguments: {} })).rejects.toThrow(
      "Structured content does not match the tool's output schema",
    )
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})

// `defs` used to end in `Effect.catch(() => Effect.void)`, so a failed `tools/list` left the
// caller with nothing but the fact of failure. Both surviving consumers then reported the fixed
// string "Failed to get tools", and the `tools/list_changed` handler dropped the refresh with no
// record at all — a permanently stale tool list nobody could explain. A timeout, a protocol error
// and a rejected auth are three different problems to go looking for, so the reason has to arrive.
describe("McpCatalog.defs", () => {
  const connect = async (name: string, handler: () => Promise<any>) => {
    const server = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, handler as any)
    const client = new Client({ name: `${name}-test`, version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    return { server, client }
  }

  test("returns the tools when the server answers", async () => {
    const { server, client } = await connect("ok", () =>
      Promise.resolve({ tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] }),
    )
    try {
      const result = await Effect.runPromise(McpCatalog.defs(client, "ok"))
      expect(result.error).toBeUndefined()
      expect(result.tools?.map((t) => t.name)).toEqual(["ping"])
    } finally {
      await client.close()
      await server.close()
    }
  })

  test("carries the reason instead of discarding it", async () => {
    const { server, client } = await connect("bad", () => Promise.reject(new Error("MCP server did not respond")))
    try {
      const result = await Effect.runPromise(McpCatalog.defs(client, "bad"))
      expect(result.tools).toBeUndefined()
      expect(result.error).toBeInstanceOf(Error)
      // The whole point: the cause survives to the message the user reads.
      expect(result.error?.message).toContain("MCP server did not respond")
      // The SDK prefixes the cause with its JSON-RPC code; what matters is that the cause is
      // there at all, where before the message was the bare "Failed to get tools".
      const message = McpCatalog.toolsFailure(result.error!)
      expect(message).toStartWith("Failed to get tools: ")
      expect(message).toContain("MCP server did not respond")
    } finally {
      await client.close()
      await server.close()
    }
  })
})
