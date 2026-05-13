import { describe, test, expect, afterEach } from "bun:test";
import { McpClient, McpManager } from "./mcp";
import { writeFileSync, mkdirSync } from "fs";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Test MCP server — a simple JSON-RPC server over stdio
// ---------------------------------------------------------------------------

function createTestMcpServer(tmpDir: string): string {
  const serverPath = join(tmpDir, "test-mcp-server.js");
  writeFileSync(serverPath, `
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin });

    const tools = [
      {
        name: "echo",
        description: "Echoes the input text",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      {
        name: "add",
        description: "Adds two numbers",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
    ];

    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "test-mcp" } }
          }) + "\\n");
        } else if (msg.method === "notifications/initialized") {
          // notification, no response
        } else if (msg.method === "tools/list") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: { tools }
          }) + "\\n");
        } else if (msg.method === "tools/call") {
          const { name, arguments: args } = msg.params;
          let content;
          if (name === "echo") {
            content = [{ type: "text", text: args.text }];
          } else if (name === "add") {
            content = [{ type: "text", text: String(args.a + args.b) }];
          } else {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0", id: msg.id,
              error: { code: -32601, message: "Unknown tool: " + name }
            }) + "\\n");
            return;
          }
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: { content }
          }) + "\\n");
        }
      } catch (e) {
        // ignore parse errors
      }
    });
  `);
  return serverPath;
}

let tmpDir: string;
let client: McpClient | null = null;
let manager: McpManager | null = null;

afterEach(() => {
  client?.close();
  client = null;
  manager?.closeAll();
  manager = null;
});

// ---------------------------------------------------------------------------
// McpClient
// ---------------------------------------------------------------------------

describe("McpClient", () => {
  test("connects and discovers tools", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const serverPath = createTestMcpServer(tmpDir);

    client = new McpClient({ command: "node", args: [serverPath] });
    await client.connect();

    const defs = client.getToolDefinitions();
    expect(defs.length).toBe(2);
    expect(defs.map(d => d.name).sort()).toEqual(["add", "echo"]);
  });

  test("applies prefix to tool names", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const serverPath = createTestMcpServer(tmpDir);

    client = new McpClient({ command: "node", args: [serverPath], prefix: "test" });
    await client.connect();

    const defs = client.getToolDefinitions();
    expect(defs[0].name).toMatch(/^mcp__test__/);
    expect(defs.map(d => d.name).sort()).toEqual(["mcp__test__add", "mcp__test__echo"]);
  });

  test("calls echo tool", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const serverPath = createTestMcpServer(tmpDir);

    client = new McpClient({ command: "node", args: [serverPath] });
    await client.connect();

    const result = await client.callTool("echo", { text: "hello mcp" });
    expect(result.output).toBe("hello mcp");
    expect(result.isError).toBeFalsy();
  });

  test("calls add tool", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const serverPath = createTestMcpServer(tmpDir);

    client = new McpClient({ command: "node", args: [serverPath] });
    await client.connect();

    const result = await client.callTool("add", { a: 3, b: 4 });
    expect(result.output).toBe("7");
  });

  test("handles prefixed tool calls", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const serverPath = createTestMcpServer(tmpDir);

    client = new McpClient({ command: "node", args: [serverPath], prefix: "test" });
    await client.connect();

    expect(client.handlesTool("mcp__test__echo")).toBe(true);
    expect(client.handlesTool("mcp__test__unknown")).toBe(false);
    expect(client.handlesTool("echo")).toBe(false); // unprefixed doesn't match

    const result = await client.callTool("mcp__test__add", { a: 10, b: 20 });
    expect(result.output).toBe("30");
  });

  test("returns error for unknown tool", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const serverPath = createTestMcpServer(tmpDir);

    client = new McpClient({ command: "node", args: [serverPath] });
    await client.connect();

    const result = await client.callTool("nonexistent", {});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("MCP tool error");
  });

  test("close kills the process", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const serverPath = createTestMcpServer(tmpDir);

    client = new McpClient({ command: "node", args: [serverPath] });
    await client.connect();
    client.close();

    // Should not throw
    client.close(); // double close is safe
    client = null;
  });
});

// ---------------------------------------------------------------------------
// McpManager
// ---------------------------------------------------------------------------

describe("McpManager", () => {
  test("connects multiple servers and merges tools", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const serverPath = createTestMcpServer(tmpDir);

    manager = new McpManager();
    await manager.connectAll([
      { command: "node", args: [serverPath], prefix: "alpha" },
      { command: "node", args: [serverPath], prefix: "beta" },
    ]);

    const defs = manager.getToolDefinitions();
    expect(defs.length).toBe(4); // 2 tools × 2 servers
    expect(defs.map(d => d.name).sort()).toEqual([
      "mcp__alpha__add", "mcp__alpha__echo",
      "mcp__beta__add", "mcp__beta__echo",
    ]);
  });

  test("routes tool calls to correct server", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const serverPath = createTestMcpServer(tmpDir);

    manager = new McpManager();
    await manager.connectAll([
      { command: "node", args: [serverPath], prefix: "s1" },
    ]);

    expect(manager.handlesTool("mcp__s1__echo")).toBe(true);
    expect(manager.handlesTool("mcp__s2__echo")).toBe(false);

    const result = await manager.callTool("mcp__s1__echo", { text: "routed" });
    expect(result).not.toBeNull();
    expect(result!.output).toBe("routed");
  });

  test("returns null for unhandled tools", async () => {
    manager = new McpManager();
    const result = await manager.callTool("unknown_tool", {});
    expect(result).toBeNull();
  });

  test("closeAll shuts down all servers", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    const serverPath = createTestMcpServer(tmpDir);

    manager = new McpManager();
    await manager.connectAll([
      { command: "node", args: [serverPath], prefix: "a" },
      { command: "node", args: [serverPath], prefix: "b" },
    ]);

    manager.closeAll();
    expect(manager.getToolDefinitions().length).toBe(0);
    manager = null;
  });
});
