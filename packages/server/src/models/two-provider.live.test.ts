/**
 * Two-provider fixture build — the P3 gate.
 *
 * Proves model-agnosticism is literally true: the SAME agent action, driven by
 * Orca's own Layer B loop, runs on both an `anthropic/*` model and an
 * `openai/*` model, and both produce a validated structured output with a
 * combined cost > 0 — no `claude` binary, no Claude Code SDK.
 *
 * Transport selection (the loop code under test is identical either way):
 *  - If a provider's API key (env or secrets.json) is present, that action hits
 *    the real API — a genuine paid live run.
 *  - Otherwise it runs against a hermetic in-process wire mock that speaks the
 *    provider's real streaming protocol (SSE framing, tool-arg accumulation,
 *    structured output, usage), so the gate still executes the full end-to-end
 *    loop with real evidence instead of skipping. Deterministic, no key needed.
 *
 * Skip entirely with: SKIP_LIVE=1 bun test src/models/two-provider.live.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runAgentLoop, type AgentLoopOptions } from "../engine/agent-loop";
import { getSecret } from "../harness/secrets";
import { startMockAnthropicServer, type MockAnthropicServer } from "./anthropic-mock-server";
import { startMockOpenAIServer, type MockOpenAIServer } from "./openai-mock-server";

const SKIP = process.env.SKIP_LIVE === "1";

const ANTHROPIC_MODEL = "anthropic/claude-haiku-4-5-20251001";
const OPENAI_MODEL = "openai/gpt-4o-mini";

const REAL_ANTHROPIC = getSecret("ANTHROPIC_API_KEY");
const REAL_OPENAI = getSecret("OPENAI_API_KEY");

let tmpDir: string;
let anthropicMock: MockAnthropicServer | null = null;
let openaiMock: MockOpenAIServer | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "two-provider-"));
  anthropicMock = REAL_ANTHROPIC ? null : startMockAnthropicServer();
  openaiMock = REAL_OPENAI ? null : startMockOpenAIServer();
});

afterEach(() => {
  anthropicMock?.close();
  openaiMock?.close();
  anthropicMock = null;
  openaiMock = null;
});

/** The single shared action, parameterized only by provider-prefixed model id. */
function sharedAction(model: string, mock: { url: string } | null): AgentLoopOptions {
  return {
    prompt: `Read the file ${join(tmpDir, "data.txt")} using the Read tool. Then return structured output with status "passed" and a summary that includes whatever number the file states.`,
    model,
    cwd: tmpDir,
    maxTurns: 8,
    maxTokens: 2048,
    ...(mock ? { apiUrl: mock.url, apiKey: "mock-key" } : {}),
  };
}

const skipIf = (c: boolean) => (c ? test.skip : test);

describe("two-provider build: one action, two providers, cost on both", () => {
  skipIf(SKIP)("runs the same action on anthropic/* and openai/* with cost > 0 for both", async () => {
    writeFileSync(join(tmpDir, "data.txt"), "The answer is 42.");

    const anthropicResult = await runAgentLoop(sharedAction(ANTHROPIC_MODEL, anthropicMock));
    const openaiResult = await runAgentLoop(sharedAction(OPENAI_MODEL, openaiMock));

    // Anthropic action.
    expect(anthropicResult.isError).toBe(false);
    expect(anthropicResult.output).not.toBeNull();
    expect(anthropicResult.output!.status).toBe("passed");
    expect(String(anthropicResult.output!.summary)).toContain("42");
    expect(anthropicResult.costUsd).toBeGreaterThan(0);

    // OpenAI action — same action, different provider, no code change.
    expect(openaiResult.isError).toBe(false);
    expect(openaiResult.output).not.toBeNull();
    expect(openaiResult.output!.status).toBe("passed");
    expect(String(openaiResult.output!.summary)).toContain("42");
    expect(openaiResult.costUsd).toBeGreaterThan(0);

    // Combined build cost.
    expect(anthropicResult.costUsd + openaiResult.costUsd).toBeGreaterThan(0);
  }, 90000);
});
