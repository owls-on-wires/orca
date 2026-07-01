/**
 * Model registry — maps a model id (prefixed, bare, or alias) to a concrete
 * provider adapter plus its price table and capabilities.
 *
 * This is the single source of truth for "which provider serves this model,
 * what does it cost, and what can it do". Both agent execution paths resolve a
 * `ModelProvider` through here by model id.
 */

import type { ModelProvider, ModelCapabilities } from "./provider";
import type { Usage } from "./types";
import { AnthropicProvider } from "./anthropic";

// ---------------------------------------------------------------------------
// Price table
// ---------------------------------------------------------------------------

/** USD per million tokens for each usage class. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelEntry {
  /** Canonical, provider-prefixed id, e.g. `anthropic/claude-sonnet-4-6`. */
  id: string;
  /** Provider that serves this model. */
  provider: ModelProvider;
  /** The id passed to the provider API (no `provider/` prefix). */
  apiModel: string;
  price: ModelPrice;
  capabilities: ModelCapabilities;
}

export interface ResolvedModel {
  id: string;
  provider: ModelProvider;
  apiModel: string;
  price: ModelPrice;
  capabilities: ModelCapabilities;
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export function computeCost(price: ModelPrice, usage: Usage): number {
  return (
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * price.cacheRead +
    usage.cacheWriteTokens * price.cacheWrite
  ) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Anthropic price presets (per million tokens)
// ---------------------------------------------------------------------------

const SONNET_PRICE: ModelPrice = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };
const OPUS_PRICE: ModelPrice = { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 };
const HAIKU_PRICE: ModelPrice = { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 };

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ModelRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  private readonly entries = new Map<string, ModelEntry>();
  private readonly aliases = new Map<string, string>();
  private defaultModel: string;

  constructor(defaultModel = "anthropic/claude-sonnet-4-6") {
    this.defaultModel = defaultModel;
  }

  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  registerModel(entry: ModelEntry): void {
    this.entries.set(entry.id, entry);
  }

  /** Register an alias (bare id or short name) -> canonical prefixed id. */
  registerAlias(alias: string, canonicalId: string): void {
    this.aliases.set(alias.toLowerCase(), canonicalId);
  }

  setDefault(canonicalId: string): void {
    this.defaultModel = canonicalId;
  }

  getProvider(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }

  listModels(): ModelEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Resolve a model id (undefined -> default, alias, bare, or prefixed) to a
   * concrete provider + price + capabilities. Throws if no provider serves it.
   */
  resolveModel(modelId?: string): ResolvedModel {
    const raw = (modelId && modelId.trim()) || this.defaultModel;
    const canonical = this.canonicalize(raw);

    const entry = this.entries.get(canonical);
    if (entry) {
      return {
        id: entry.id,
        provider: entry.provider,
        apiModel: entry.apiModel,
        price: entry.price,
        capabilities: entry.capabilities,
      };
    }

    // Unknown-but-serviceable model: find a provider that claims it, infer a
    // price by family, and return a best-effort resolution rather than failing.
    const provider = this.findProvider(canonical);
    if (!provider) {
      throw new Error(`No provider registered for model id: ${modelId ?? raw}`);
    }
    const apiModel = this.stripPrefix(canonical, provider.id);
    return {
      id: canonical,
      provider,
      apiModel,
      price: inferPrice(apiModel),
      capabilities: provider.capabilities,
    };
  }

  /** Normalize aliases and bare ids to a canonical `provider/model` id. */
  private canonicalize(id: string): string {
    const lower = id.toLowerCase();
    const aliased = this.aliases.get(lower);
    if (aliased) return aliased;
    if (this.entries.has(id)) return id;
    if (id.includes("/")) return id;
    // Bare id — attribute to a provider by prefix guess.
    if (lower.startsWith("claude")) return `anthropic/${id}`;
    if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3")) {
      return `openai/${id}`;
    }
    return id;
  }

  private stripPrefix(id: string, providerId: string): string {
    return id.startsWith(`${providerId}/`) ? id.slice(providerId.length + 1) : id;
  }

  private findProvider(canonical: string): ModelProvider | undefined {
    const slash = canonical.indexOf("/");
    if (slash > 0) {
      const p = this.providers.get(canonical.slice(0, slash));
      if (p) return p;
    }
    for (const provider of this.providers.values()) {
      if (provider.supports(canonical)) return provider;
    }
    return undefined;
  }
}

function inferPrice(apiModel: string): ModelPrice {
  const m = apiModel.toLowerCase();
  if (m.includes("opus")) return OPUS_PRICE;
  if (m.includes("haiku")) return HAIKU_PRICE;
  return SONNET_PRICE;
}

// ---------------------------------------------------------------------------
// Default registry — the process-wide instance the runtime uses.
// ---------------------------------------------------------------------------

export function buildDefaultRegistry(): ModelRegistry {
  const registry = new ModelRegistry("anthropic/claude-sonnet-4-6");

  const anthropic = new AnthropicProvider();
  registry.registerProvider(anthropic);

  const anthropicModels: Array<{ apiModel: string; price: ModelPrice }> = [
    { apiModel: "claude-sonnet-4-6", price: SONNET_PRICE },
    { apiModel: "claude-sonnet-4-20250514", price: SONNET_PRICE },
    { apiModel: "claude-opus-4-6", price: OPUS_PRICE },
    { apiModel: "claude-opus-4-20250514", price: OPUS_PRICE },
    { apiModel: "claude-haiku-4-5-20251001", price: HAIKU_PRICE },
  ];

  for (const { apiModel, price } of anthropicModels) {
    registry.registerModel({
      id: `anthropic/${apiModel}`,
      provider: anthropic,
      apiModel,
      price,
      capabilities: anthropic.capabilities,
    });
  }

  // Short-name aliases (preserve prior resolveModelId behavior).
  registry.registerAlias("opus", "anthropic/claude-opus-4-6");
  registry.registerAlias("sonnet", "anthropic/claude-sonnet-4-6");
  registry.registerAlias("haiku", "anthropic/claude-haiku-4-5-20251001");

  return registry;
}

let sharedRegistry: ModelRegistry | null = null;

/** The process-wide registry used by the agent runtime. */
export function defaultRegistry(): ModelRegistry {
  if (!sharedRegistry) sharedRegistry = buildDefaultRegistry();
  return sharedRegistry;
}

/** Convenience: resolve a model id against the shared registry. */
export function resolveModel(modelId?: string): ResolvedModel {
  return defaultRegistry().resolveModel(modelId);
}
