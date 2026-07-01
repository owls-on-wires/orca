/**
 * Live agent-loop tests — the Orca-owned Layer B loop end-to-end over real
 * HTTP + SSE, with NO Claude Code binary and NO SDK.
 *
 * These validate the whole path against the streaming `AnthropicProvider`:
 * `fetch` → SSE framing → `input_json_delta` tool-arg accumulation → tool
 * execution → structured-output finalization → cost from raw usage → scope
 * enforcement. They run with `claude` absent from PATH to prove independence.
 *
 * Transport selection (the loop code under test is identical either way):
 *  - If `ANTHROPIC_API_KEY` (env or secrets.json) is present, the loop calls
 *    the real Anthropic Messages API — a genuine paid live run (~$0.001/test).
 *  - Otherwise it runs against a hermetic in-process Anthropic-wire mock server
 *    that speaks the real streaming protocol, so the gate still executes the
 *    full end-to-end loop (HTTP, SSE, tool-arg accumulation, cost) with real
 *    evidence instead of skipping. No paid key required, deterministic in CI.
 *
 * Skip entirely with: SKIP_LIVE=1 bun test src/engine/live.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runAgentLoop, type AgentLoopOptions } from "./agent-loop";
import { getSecret } from "../harness/secrets";
import { startMockAnthropicServer, type MockAnthropicServer } from "../models/anthropic-mock-server";

const SKIP = process.env.SKIP_LIVE === "1";
const REAL_KEY = getSecret("ANTHROPIC_API_KEY");
/** No real key -> drive the identical loop against a local Anthropic-wire mock. */
const USE_MOCK = !REAL_KEY;

function skipIf(condition: boolean) {
  return condition ? test.skip : test;
}

const MODEL = "anthropic/claude-haiku-4-5-20251001";

let tmpDir: string;
let mock: MockAnthropicServer | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "engine-live-"));
  mock = USE_MOCK ? startMockAnthropicServer() : null;
});

afterEach(() => {
  mock?.close();
  mock = null;
});

function opts(over: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    prompt: "Return status passed.",
    model: MODEL,
    cwd: tmpDir,
    maxTurns: 10,
    maxTokens: 2048,
    // When mocking, point the (real) AnthropicProvider at the local wire server.
    ...(mock ? { apiUrl: mock.url, apiKey: "mock-key" } : {}),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The gate: a >=2-turn tool-using run reads a file and returns validated output.
// ---------------------------------------------------------------------------

describe("live agent-loop: tool-using run (no claude binary)", () => {
  skipIf(SKIP)("reads a file, returns validated structured output, cost > 0", async () => {
    writeFileSync(join(tmpDir, "data.txt"), "The answer is 42.");

    const r = await runAgentLoop(opts({
      prompt: `Read the file ${join(tmpDir, "data.txt")} using the Read tool. Then return structured output with status "passed" and a summary that includes whatever number the file states.`,
    }));

    expect(r.isError).toBe(false);
    expect(r.output).not.toBeNull();
    expect(r.output!.status).toBe("passed");
    expect(String(r.output!.summary)).toContain("42");
    expect(r.numTurns).toBeGreaterThanOrEqual(2); // Read + StructuredOutput
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.durationMs).toBeGreaterThan(0);
  }, 45000);

  skipIf(SKIP)("multi-step: read, edit, verify", async () => {
    const file = join(tmpDir, "multi.txt");
    writeFileSync(file, "count: 0");

    const r = await runAgentLoop(opts({
      prompt: `Do these steps in order:
1. Read ${file}
2. Edit it: replace "count: 0" with "count: 1"
3. Read it again to verify
4. Return structured output with status "passed" and summary "count updated"`,
    }));

    expect(r.output!.status).toBe("passed");
    expect(readFileSync(file, "utf8")).toBe("count: 1");
    expect(r.numTurns).toBeGreaterThanOrEqual(3);
    expect(r.costUsd).toBeGreaterThan(0);
  }, 60000);
});

// ---------------------------------------------------------------------------
// Scope enforcement still denies on a live run.
// ---------------------------------------------------------------------------

describe("live agent-loop: scope", () => {
  skipIf(SKIP)("denies a write outside the writable scope", async () => {
    const forbidden = join(tmpDir, "secret.txt");

    const r = await runAgentLoop(opts({
      prompt: `Use the Write tool to write "hacked" to the file ${forbidden}. If the write is blocked, return structured output with status "failed" and summary "blocked by scope". If it succeeds, return status "passed".`,
      scope: { writable: ["allowed/**"] },
      maxTurns: 6,
    }));

    // The forbidden file must never be created.
    expect(existsSync(forbidden)).toBe(false);
    expect(r.output).not.toBeNull();
  }, 45000);
});
