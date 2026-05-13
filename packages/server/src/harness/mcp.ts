/**
 * MCP (Model Context Protocol) client for the agent harness.
 *
 * Connects to MCP servers via stdio, discovers tools, and forwards
 * tool calls from the agent loop.
 */

import { spawn, type ChildProcess } from "child_process";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import type { ToolDefinition, ToolResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: object;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Prefix added to tool names to namespace them (e.g., "playwright" → "mcp__playwright__toolname") */
  prefix?: string;
}

// ---------------------------------------------------------------------------
// MCP Client
// ---------------------------------------------------------------------------

export class McpClient {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private tools: McpToolInfo[] = [];
  private prefix: string;
  private config: McpServerConfig;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.prefix = config.prefix ?? "";
  }

  /** Start the MCP server process and complete the initialization handshake. */
  async connect(): Promise<void> {
    this.process = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.config.env },
      cwd: this.config.cwd,
    });

    this.readline = createInterface({ input: this.process.stdout! });

    this.readline.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
        if ("id" in msg && msg.id != null) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            if ("error" in msg && msg.error) {
              pending.reject(new Error(`MCP error: ${msg.error.message}`));
            } else {
              pending.resolve(msg.result);
            }
          }
        }
        // Notifications (no id) are ignored for now
      } catch {
        // Non-JSON lines ignored
      }
    });

    this.process.on("error", (err) => {
      for (const { reject } of this.pending.values()) {
        reject(err);
      }
      this.pending.clear();
    });

    // Initialize handshake
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "orca-harness", version: "1.0.0" },
    });

    // Send initialized notification
    this.notify("notifications/initialized", {});

    // Discover tools
    const result = await this.request("tools/list", {}) as { tools: McpToolInfo[] };
    this.tools = result.tools ?? [];
  }

  /** Get tool definitions suitable for the Anthropic API. */
  getToolDefinitions(): ToolDefinition[] {
    return this.tools.map((tool) => ({
      name: this.prefixName(tool.name),
      description: tool.description ?? "",
      input_schema: tool.inputSchema,
    }));
  }

  /** Check if a tool name belongs to this MCP server. */
  handlesTool(name: string): boolean {
    // If this client uses a prefix, the tool name must have it
    if (this.prefix && !name.startsWith(`mcp__${this.prefix}__`)) return false;
    const unprefixed = this.unprefixName(name);
    return this.tools.some((t) => t.name === unprefixed);
  }

  /** Execute a tool call via the MCP server. */
  async callTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const unprefixed = this.unprefixName(name);

    try {
      const result = await this.request("tools/call", {
        name: unprefixed,
        arguments: input,
      }) as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };

      // Concatenate text content blocks
      const parts: string[] = [];
      for (const block of result.content ?? []) {
        if (block.type === "text" && block.text) {
          parts.push(block.text);
        } else if (block.type === "image" && block.data) {
          parts.push(`[image: ${block.mimeType ?? "image/png"}, ${block.data.length} bytes base64]`);
        } else if (block.type === "resource") {
          parts.push(`[resource: ${JSON.stringify(block)}]`);
        }
      }

      return { output: parts.join("\n") || "(no output)" };
    } catch (e: any) {
      return { output: `MCP tool error: ${e.message}`, isError: true };
    }
  }

  /** Shut down the MCP server. */
  close(): void {
    try {
      this.readline?.close();
      this.process?.kill();
    } catch {}
    for (const { reject } of this.pending.values()) {
      reject(new Error("MCP client closed"));
    }
    this.pending.clear();
    this.process = null;
    this.readline = null;
  }

  private prefixName(name: string): string {
    return this.prefix ? `mcp__${this.prefix}__${name}` : name;
  }

  private unprefixName(name: string): string {
    const pfx = this.prefix ? `mcp__${this.prefix}__` : "";
    return pfx && name.startsWith(pfx) ? name.slice(pfx.length) : name;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin) {
        reject(new Error("MCP process not running"));
        return;
      }

      const id = this.nextId++;
      const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

      this.pending.set(id, { resolve, reject });

      const data = JSON.stringify(msg) + "\n";
      this.process.stdin.write(data, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });

      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.process?.stdin) return;
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.process.stdin.write(JSON.stringify(msg) + "\n");
  }
}

// ---------------------------------------------------------------------------
// MCP Manager — manages multiple MCP servers for an agent action
// ---------------------------------------------------------------------------

export class McpManager {
  private clients: McpClient[] = [];

  /** Connect to all configured MCP servers. */
  async connectAll(configs: McpServerConfig[]): Promise<void> {
    for (const config of configs) {
      const client = new McpClient(config);
      await client.connect();
      this.clients.push(client);
    }
  }

  /** Get all tool definitions from all connected MCP servers. */
  getToolDefinitions(): ToolDefinition[] {
    return this.clients.flatMap((c) => c.getToolDefinitions());
  }

  /** Find the client that handles a given tool name and call it. */
  async callTool(name: string, input: Record<string, unknown>): Promise<ToolResult | null> {
    for (const client of this.clients) {
      if (client.handlesTool(name)) {
        return client.callTool(name, input);
      }
    }
    return null; // no MCP server handles this tool
  }

  /** Check if any MCP server handles this tool. */
  handlesTool(name: string): boolean {
    return this.clients.some((c) => c.handlesTool(name));
  }

  /** Shut down all MCP servers. */
  closeAll(): void {
    for (const client of this.clients) {
      client.close();
    }
    this.clients = [];
  }
}
