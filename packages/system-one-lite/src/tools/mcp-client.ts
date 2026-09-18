/**
 * MCP client wrapper using @modelcontextprotocol/sdk.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import type { ToolResult } from "./kit/adapter.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpTransport = StdioClientTransport | StreamableHTTPClientTransport;

export class McpClient {
  private serverId: string;
  private client: Client;
  private transport: McpTransport;

  constructor(serverId: string, transport: McpTransport) {
    this.serverId = serverId;
    this.transport = transport;
    this.client = new Client({ name: `system-one-lite-${serverId}`, version: "0.1.0" }, { capabilities: {} });
  }

  /**
   * Connect to an MCP server via stdio.
   */
  static async connectStdio(serverId: string, command: string, args: string[] = []): Promise<McpClient> {
    const transport = new StdioClientTransport({ command, args });
    const client = new McpClient(serverId, transport);
    await client.client.connect(transport);
    return client;
  }

  /**
   * Connect to an MCP server via HTTP.
   */
  static async connectHttp(serverId: string, url: string): Promise<McpClient> {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new McpClient(serverId, transport);
    await client.client.connect(transport);
    return client;
  }

  /**
   * List available tools.
   */
  async listTools(): Promise<ToolDefinition[]> {
    const result = await this.client.listTools();
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
    const result = await this.client.callTool({ name, arguments: args });
    return {
      content: result.content,
      isError: result.isError,
    };
  }

  /**
   * Close the connection.
   */
  async close(): Promise<void> {
    await this.client.close();
  }
}
