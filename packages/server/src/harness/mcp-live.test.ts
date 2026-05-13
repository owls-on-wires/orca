/**
 * Live MCP tests — connect to the real Playwright MCP server and
 * test browser automation via the agent harness.
 *
 * Requires: npx @playwright/mcp (installed on demand)
 *
 * Skip with: SKIP_LIVE=1 bun test src/harness/mcp-live.test.ts
 */

import { describe, test, expect, afterEach } from "bun:test";
import { McpClient } from "./mcp";
import { runAgentLoop } from "./loop";
import { getSecret } from "./secrets";
import type { HarnessOptions } from "./types";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SKIP = process.env.SKIP_LIVE === "1" || !getSecret("ANTHROPIC_API_KEY");

function skipIf(condition: boolean) {
  return condition ? test.skip : test;
}

let client: McpClient | null = null;

afterEach(() => {
  client?.close();
  client = null;
});

// ---------------------------------------------------------------------------
// Playwright MCP server — direct client tests
// ---------------------------------------------------------------------------

describe("live MCP: Playwright server", () => {
  skipIf(SKIP)("connects to Playwright MCP and discovers browser tools", async () => {
    client = new McpClient({
      command: "npx",
      args: ["@playwright/mcp", "--headless", "--executable-path", "/run/current-system/sw/bin/chromium"],
      prefix: "playwright",
    });
    await client.connect();

    const defs = client.getToolDefinitions();
    expect(defs.length).toBeGreaterThan(5);

    const names = defs.map((d) => d.name);
    expect(names).toContain("mcp__playwright__browser_navigate");
    expect(names).toContain("mcp__playwright__browser_snapshot");
    expect(names).toContain("mcp__playwright__browser_click");
  }, 30000);

  skipIf(SKIP)("navigates to a page and takes a snapshot", async () => {
    client = new McpClient({
      command: "npx",
      args: ["@playwright/mcp", "--headless", "--executable-path", "/run/current-system/sw/bin/chromium"],
      prefix: "playwright",
    });
    await client.connect();

    // Navigate to a simple data URL
    const navResult = await client.callTool("mcp__playwright__browser_navigate", {
      url: "data:text/html,<h1>Hello Orca</h1><p>MCP test page</p>",
    });
    expect(navResult.isError).toBeFalsy();

    // Take a snapshot (accessibility tree)
    const snapResult = await client.callTool("mcp__playwright__browser_snapshot", {});
    expect(snapResult.isError).toBeFalsy();
    expect(snapResult.output).toContain("Hello Orca");
  }, 30000);

  skipIf(SKIP)("clicks an element on the page", async () => {
    client = new McpClient({
      command: "npx",
      args: ["@playwright/mcp", "--headless", "--executable-path", "/run/current-system/sw/bin/chromium"],
      prefix: "playwright",
    });
    await client.connect();

    // Navigate to a page with a button
    await client.callTool("mcp__playwright__browser_navigate", {
      url: `data:text/html,<button onclick="document.title='clicked'">Click Me</button>`,
    });

    // Snapshot to find the button ref
    const snap = await client.callTool("mcp__playwright__browser_snapshot", {});
    expect(snap.output).toContain("Click Me");

    // Click the button — use the text ref from snapshot
    const clickResult = await client.callTool("mcp__playwright__browser_click", {
      element: "Click Me",
      ref: "e1",
    });
    // Click should succeed (or at least not error fatally)
    expect(clickResult.isError).toBeFalsy();
  }, 30000);
});

// ---------------------------------------------------------------------------
// Agent + Playwright MCP — full harness integration
// ---------------------------------------------------------------------------

describe("live MCP: agent with Playwright", () => {
  skipIf(SKIP)("agent navigates and reads page content", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mcp-agent-"));

    const result = await runAgentLoop({
      prompt: `Use the Playwright browser tools to navigate to this URL:
data:text/html,<h1>Agent Test</h1><p>The secret number is 7742.</p>

Then take a browser snapshot to read the page content.
Return structured output with status "passed" and summary containing the secret number from the page.`,
      model: "claude-haiku-4-5-20251001",
      cwd: tmpDir,
      maxTurns: 10,
      maxTokens: 4096,
      mcpServers: [{
        command: "npx",
        args: ["@playwright/mcp", "--headless", "--executable-path", "/run/current-system/sw/bin/chromium"],
        prefix: "playwright",
      }],
    });

    expect(result.isError).toBe(false);
    expect(result.output).not.toBeNull();
    expect(result.output!.status).toBe("passed");
    expect(result.output!.summary).toContain("7742");
  }, 60000);

  skipIf(SKIP)("agent interacts with a form", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mcp-agent-"));

    const html = `data:text/html,
<html><body>
<h1>Form Test</h1>
<input id="name" type="text" placeholder="Enter name">
<button onclick="document.getElementById('result').textContent='Hello ' + document.getElementById('name').value">Submit</button>
<div id="result"></div>
</body></html>`;

    const result = await runAgentLoop({
      prompt: `Use the Playwright browser tools:
1. Navigate to: ${html}
2. Take a snapshot to see the form
3. Type "Orca" into the input field
4. Click the Submit button
5. Take another snapshot to see the result
6. Return structured output with status "passed" and summary containing whatever text appeared in the result div.`,
      model: "claude-haiku-4-5-20251001",
      cwd: tmpDir,
      maxTurns: 15,
      maxTokens: 4096,
      mcpServers: [{
        command: "npx",
        args: ["@playwright/mcp", "--headless", "--executable-path", "/run/current-system/sw/bin/chromium"],
        prefix: "playwright",
      }],
    });

    expect(result.isError).toBe(false);
    expect(result.output).not.toBeNull();
    expect(result.output!.status).toBe("passed");
    expect(result.output!.summary).toContain("Orca");
  }, 90000);
});
