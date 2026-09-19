/**
 * MCP client wrapper using @modelcontextprotocol/sdk.
 * Imports are lazy so the module loads even if the SDK is missing.
 */

import type { ToolResult } from "./kit/adapter.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpTransport = any;

export class McpClient {
  private serverId: string;
  private client: any;
  private transport: McpTransport;

  constructor(serverId: string, transport: McpTransport) {
    this.serverId = serverId;
    this.transport = transport;
    // Client is created lazily in connect() to avoid eager SDK import
    this.client = null;
  }

  private async ensureClient(sdk: any) {
    if (!this.client) {
      this.client = new sdk.Client({ name: `system-one-lite-${this.serverId}`, version: "0.1.0" }, { capabilities: {} });
    }
    return this.client;
  }

  /**
   * Connect to an MCP server via stdio.
   */
  static async connectStdio(serverId: string, command: string, args: string[] = []): Promise<McpClient> {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio");
    const transport = new StdioClientTransport({ command, args });
    const client = new McpClient(serverId, transport as any);
    await client.connect();
    return client;
  }

  /**
   * Connect to an MCP server via HTTP.
   */
  static async connectHttp(serverId: string, url: string): Promise<McpClient> {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp");
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new McpClient(serverId, transport);
    await client.connect();
    return client;
  }

  private async connect(): Promise<void> {
    const sdk = await import("@modelcontextprotocol/sdk/client/index");
    const client = await this.ensureClient(sdk);
    await client.connect(this.transport);
  }

  /**
   * List available tools.
   */
  async listTools(): Promise<ToolDefinition[]> {
    const sdk = await import("@modelcontextprotocol/sdk/client/index");
    const client = await this.ensureClient(sdk);
    const result = await client.listTools();
    return result.tools.map((t: any) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? {},
    }));
  }

  /**
   * Call a tool.
   */
  async callTool(name: string, args: Record<string, any>): Promise<ToolResult> {
    const sdk = await import("@modelcontextprotocol/sdk/client/index");
    const client = await this.ensureClient(sdk);
    const result = await client.callTool({ name, arguments: args });
    return {
      content: result.content,
      isError: result.isError,
    };
  }

  /**
   * Close the connection.
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
    }
  }
}
