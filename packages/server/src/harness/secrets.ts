/**
 * Load secrets from packages/server/secrets.json.
 *
 * Format: { "ANTHROPIC_API_KEY": "sk-ant-..." }
 *
 * Falls back to environment variables if the file doesn't exist.
 */

import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";

let cached: Record<string, string> | null = null;

function findSecretsPath(): string {
  // Resolve relative to this file's package: packages/server/secrets.json
  const fromFile = resolve(dirname(import.meta.path), "../../secrets.json");
  if (existsSync(fromFile)) return fromFile;

  // Also check cwd-relative (for when run from project root)
  const fromCwd = resolve(process.cwd(), "packages/server/secrets.json");
  if (existsSync(fromCwd)) return fromCwd;

  return fromFile; // default path for error messages
}

function loadSecrets(): Record<string, string> {
  if (cached) return cached;

  const path = findSecretsPath();
  if (existsSync(path)) {
    try {
      cached = JSON.parse(readFileSync(path, "utf8"));
      return cached!;
    } catch {
      return {};
    }
  }

  cached = {};
  return cached;
}

export function getSecret(key: string): string | undefined {
  const secrets = loadSecrets();
  return secrets[key] ?? process.env[key];
}
