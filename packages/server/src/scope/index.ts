/**
 * File scope enforcement.
 *
 * Three layers:
 * 1. can_use_tool callback (blocks before execution)
 * 2. System prompt injection (agent awareness)
 * 3. Post-hoc violation detection (logging)
 */

import { resolve, relative } from "path";
import type { ScopeConfig } from "../config/schema";
import { scopeMatch } from "./matcher";

export interface ScopeViolation {
  toolName: string;
  filePath: string;
  scopeType: "read" | "write";
  allowedPatterns: string[];
}

const WRITE_TOOLS = new Set(["Write", "Edit"]);
const READ_TOOLS = new Set(["Read"]);
const SEARCH_TOOLS = new Set(["Glob", "Grep"]);

export function checkToolUse(
  scope: ScopeConfig,
  toolName: string,
  toolInput: Record<string, unknown>,
  projectDir: string,
): ScopeViolation | null {
  if (WRITE_TOOLS.has(toolName)) {
    const fp = toolInput.file_path as string | undefined;
    if (fp && scope.writable?.length && !allowsAccess(fp, scope.writable, projectDir)) {
      return { toolName, filePath: fp, scopeType: "write", allowedPatterns: scope.writable };
    }
  } else if (READ_TOOLS.has(toolName)) {
    const fp = toolInput.file_path as string | undefined;
    if (fp && scope.readable?.length && !allowsAccess(fp, scope.readable, projectDir)) {
      return { toolName, filePath: fp, scopeType: "read", allowedPatterns: scope.readable };
    }
  } else if (SEARCH_TOOLS.has(toolName)) {
    const searchPath = toolInput.path as string | undefined;
    if (searchPath && scope.readable?.length && !allowsAccess(searchPath, scope.readable, projectDir)) {
      return { toolName, filePath: searchPath, scopeType: "read", allowedPatterns: scope.readable };
    }
  }
  return null;
}

function allowsAccess(filePath: string, patterns: string[], projectDir: string): boolean {
  try {
    const rel = relative(resolve(projectDir), resolve(filePath));
    if (rel.startsWith("..")) return false;
    return scopeMatch(rel, patterns);
  } catch {
    return false;
  }
}

export function scopeSystemPrompt(scope: ScopeConfig): string {
  const lines = [
    "## File Access Scope",
    "",
    "IMPORTANT: You are restricted to the following file access scope.",
    "",
  ];
  if (scope.writable?.length) {
    lines.push("**Writable** (Write, Edit):");
    for (const p of scope.writable) lines.push(`- \`${p}\``);
    lines.push("");
  }
  if (scope.readable?.length) {
    lines.push("**Readable** (Read, Glob, Grep):");
    for (const p of scope.readable) lines.push(`- \`${p}\``);
    lines.push("");
  }
  lines.push(
    "Do NOT access files outside this scope.",
    "Do NOT use Bash to bypass these restrictions.",
    "If you need a file outside the scope, return an escalation.",
  );
  return lines.join("\n");
}
