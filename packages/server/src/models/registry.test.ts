import { describe, test, expect } from "bun:test";
import { buildDefaultRegistry, computeCost, resolveModel } from "./registry";
import type { Usage } from "./types";

describe("model registry — resolution", () => {
  const registry = buildDefaultRegistry();

  test("resolves a canonical prefixed id", () => {
    const r = registry.resolveModel("anthropic/claude-opus-4-6");
    expect(r.id).toBe("anthropic/claude-opus-4-6");
    expect(r.apiModel).toBe("claude-opus-4-6");
    expect(r.provider.id).toBe("anthropic");
    expect(r.price.input).toBe(15.0);
  });

  test("resolves a bare claude id to the anthropic provider", () => {
    const r = registry.resolveModel("claude-sonnet-4-6");
    expect(r.id).toBe("anthropic/claude-sonnet-4-6");
    expect(r.apiModel).toBe("claude-sonnet-4-6");
    expect(r.provider.id).toBe("anthropic");
  });

  test("resolves short-name aliases (opus/sonnet/haiku)", () => {
    expect(registry.resolveModel("opus").apiModel).toBe("claude-opus-4-6");
    expect(registry.resolveModel("sonnet").apiModel).toBe("claude-sonnet-4-6");
    expect(registry.resolveModel("haiku").apiModel).toBe("claude-haiku-4-5-20251001");
  });

  test("undefined model resolves to the default", () => {
    const r = registry.resolveModel(undefined);
    expect(r.id).toBe("anthropic/claude-sonnet-4-6");
    expect(r.provider.id).toBe("anthropic");
  });

  test("unknown-but-serviceable claude id gets a best-effort family price", () => {
    const r = registry.resolveModel("claude-opus-9-future");
    expect(r.provider.id).toBe("anthropic");
    expect(r.apiModel).toBe("claude-opus-9-future");
    expect(r.price.input).toBe(15.0); // opus family
  });

  test("throws for a model no provider serves", () => {
    expect(() => registry.resolveModel("mistral/large")).toThrow(/No provider registered/);
  });

  test("exposes capabilities from the resolved provider", () => {
    const r = registry.resolveModel("sonnet");
    expect(r.capabilities.structuredOutput).toBe(true);
    expect(r.capabilities.promptCaching).toBe(true);
    expect(r.capabilities.maxContextTokens).toBeGreaterThan(0);
  });

  test("the shared registry helper resolves the same way", () => {
    expect(resolveModel("opus").apiModel).toBe("claude-opus-4-6");
  });

  test("lists registered models", () => {
    const ids = registry.listModels().map((m) => m.id);
    expect(ids).toContain("anthropic/claude-sonnet-4-6");
    expect(ids).toContain("anthropic/claude-opus-4-6");
    expect(ids).toContain("anthropic/claude-haiku-4-5-20251001");
  });
});

describe("model registry — cost", () => {
  const usage: Usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 };

  test("sonnet input+output cost", () => {
    const price = resolveModel("sonnet").price;
    expect(computeCost(price, usage)).toBe(3.0 + 15.0);
  });

  test("opus input+output cost", () => {
    const price = resolveModel("opus").price;
    expect(computeCost(price, usage)).toBe(15.0 + 75.0);
  });

  test("haiku input+output cost", () => {
    const price = resolveModel("haiku").price;
    expect(computeCost(price, usage)).toBe(0.8 + 4.0);
  });

  test("cache-read priced below input; cache-write priced above", () => {
    const price = resolveModel("sonnet").price;
    const readCost = computeCost(price, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 });
    const writeCost = computeCost(price, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 });
    expect(readCost).toBeCloseTo(0.3);
    expect(writeCost).toBeCloseTo(3.75);
    expect(readCost).toBeLessThan(price.input);
    expect(writeCost).toBeGreaterThan(price.input);
  });

  test("zero usage is zero cost", () => {
    const price = resolveModel("sonnet").price;
    expect(computeCost(price, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0);
  });
});
