/**
 * Glob pattern matching with ** support.
 * Used for file scope enforcement.
 */

/** Match a relative path against a single glob pattern. */
export function globMatch(path: string, pattern: string): boolean {
  if (!pattern.includes("**")) {
    return simpleMatch(path, pattern);
  }

  const [before, after] = pattern.split("**", 2);
  const prefix = before.replace(/\/$/, "");
  const suffix = after.replace(/^\//, "");

  // Check prefix
  if (prefix) {
    if (path === prefix) return !suffix;
    if (!path.startsWith(prefix + "/")) return false;
    path = path.slice(prefix.length + 1);
  }

  // No suffix = ** matches everything
  if (!suffix) return true;

  // Match suffix against every possible tail
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const candidate = parts.slice(i).join("/");
    if (simpleMatch(candidate, suffix)) return true;
  }

  return false;
}

/** Simple fnmatch-style matching (no **). */
function simpleMatch(str: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`).test(str);
}

/** Check if a path matches any of the patterns. */
export function scopeMatch(path: string, patterns: string[]): boolean {
  return patterns.some((p) => globMatch(path, p));
}
