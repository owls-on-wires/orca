/**
 * Live cache tests — verify prompt caching works with the Anthropic API.
 *
 * Uses Haiku. Requires >4096 tokens in system+tools for caching to activate.
 * Cache has a 5-minute TTL, so results depend on whether a cache already exists.
 *
 * Skip with: SKIP_LIVE=1 bun test src/harness/cache-live.test.ts
 */

import { describe, test, expect } from "bun:test";
import { runAgentLoop } from "./loop";
import { getSecret } from "./secrets";
import { readFileSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SKIP = process.env.SKIP_LIVE === "1" || !getSecret("ANTHROPIC_API_KEY");

function skipIf(condition: boolean) {
  return condition ? test.skip : test;
}

const MODEL = "claude-haiku-4-5-20251001";

// Generate a large system prompt that exceeds the 4096 token cache minimum for Haiku
const LARGE_CONTEXT = "You are a test agent.\n\nHere is the project specification:\n" +
  Array.from({ length: 200 }, (_, i) =>
    `Section ${i + 1}: This section describes feature ${i + 1} of the system. ` +
    `It involves handling data validation, error checking, and proper response formatting. ` +
    `The implementation should follow existing patterns and maintain backward compatibility.`
  ).join("\n\n");

describe("live cache: prompt caching", () => {
  skipIf(SKIP)("multi-turn action uses cache on subsequent turns", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cache-test-"));
    const logPath = join(tmpDir, "cache.jsonl");
    writeFileSync(join(tmpDir, "data.txt"), "The answer is 42.");

    const result = await runAgentLoop({
      prompt: `Read the file ${join(tmpDir, "data.txt")}. Then return structured output with status "passed" and summary "done".`,
      systemPrompt: LARGE_CONTEXT,
      model: MODEL,
      cwd: tmpDir,
      maxTurns: 5,
      maxTokens: 1024,
      logPath,
      label: "cache-test",
    });

    expect(result.isError).toBe(false);
    expect(result.output?.status).toBe("passed");
    expect(result.numTurns).toBeGreaterThanOrEqual(2);

    const lines = readFileSync(logPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
    const turns = lines.filter(l => l.event_type === "api_turn");
    expect(turns.length).toBeGreaterThanOrEqual(2);

    // On turn 2, the system prompt + tools should be cached
    // Either from cache_creation on turn 1 (fresh) or cache_read (warm cache from prior run)
    const turn2 = turns[1];
    const cacheActivity = turn2.cache_read_tokens + turn2.cache_creation_tokens;
    expect(cacheActivity).toBeGreaterThan(0);

    // Cache read should include the large system prompt (>4K tokens)
    // On a warm cache, turn 2 reads; on a cold cache, turn 1 creates and turn 2 reads
    const totalCacheRead = turns.reduce((s: number, t: any) => s + t.cache_read_tokens, 0);
    expect(totalCacheRead).toBeGreaterThan(4000);
  }, 30000);

  skipIf(SKIP)("cache read tokens reduce fresh input tokens", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cache-cost-"));
    const logPath = join(tmpDir, "cost.jsonl");
    writeFileSync(join(tmpDir, "a.txt"), "File A content");
    writeFileSync(join(tmpDir, "b.txt"), "File B content");

    const result = await runAgentLoop({
      prompt: `Read ${join(tmpDir, "a.txt")}, then read ${join(tmpDir, "b.txt")}, then return structured output with status "passed".`,
      systemPrompt: LARGE_CONTEXT,
      model: MODEL,
      cwd: tmpDir,
      maxTurns: 10,
      maxTokens: 1024,
      logPath,
      label: "cache-cost",
    });

    expect(result.output?.status).toBe("passed");

    const lines = readFileSync(logPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
    const turns = lines.filter(l => l.event_type === "api_turn");
    expect(turns.length).toBeGreaterThanOrEqual(2);

    // Total cache reads across all turns should be substantial
    const totalCacheRead = turns.reduce((s: number, t: any) => s + t.cache_read_tokens, 0);
    expect(totalCacheRead).toBeGreaterThan(4000);

    // Fresh input tokens on later turns should be small relative to cache reads
    // (most of the context is served from cache)
    const lastTurn = turns[turns.length - 1];
    if (lastTurn.cache_read_tokens > 0) {
      expect(lastTurn.cache_read_tokens).toBeGreaterThan(lastTurn.input_tokens);
    }
  }, 45000);

  skipIf(SKIP)("invoke_end logs total cache tokens", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cache-log-"));
    const logPath = join(tmpDir, "log.jsonl");

    await runAgentLoop({
      prompt: "Return structured output with status passed and summary cached.",
      systemPrompt: LARGE_CONTEXT,
      model: MODEL,
      cwd: tmpDir,
      maxTurns: 3,
      maxTokens: 1024,
      logPath,
      label: "cache-log",
    });

    const lines = readFileSync(logPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
    const end = lines.find(l => l.event_type === "invoke_end");

    expect(end).toBeDefined();
    expect(typeof end.total_cache_read_tokens).toBe("number");
  }, 30000);

  skipIf(SKIP)("small prompts below threshold still work without cache", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cache-small-"));
    const logPath = join(tmpDir, "small.jsonl");

    const result = await runAgentLoop({
      prompt: "Return structured output with status passed.",
      systemPrompt: "Be brief.",
      model: MODEL,
      cwd: tmpDir,
      maxTurns: 3,
      maxTokens: 512,
      logPath,
      label: "cache-small",
    });

    expect(result.isError).toBe(false);
    expect(result.output?.status).toBe("passed");

    // Below threshold — no cache activity
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
    const turns = lines.filter(l => l.event_type === "api_turn");
    for (const t of turns) {
      expect(t.cache_creation_tokens).toBe(0);
      expect(t.cache_read_tokens).toBe(0);
    }
  }, 15000);
});
