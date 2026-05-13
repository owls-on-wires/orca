/**
 * Tool definitions and implementations for the agent harness.
 *
 * Each tool has:
 * - A JSON Schema definition (sent to the API)
 * - An executor function (runs locally when the model calls the tool)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, resolve, join } from "path";
import type { ToolDefinition, ToolExecutor, ToolContext, ToolResult } from "./types";

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolExecutor;
}

const registry = new Map<string, RegisteredTool>();

export function registerTool(name: string, definition: ToolDefinition, execute: ToolExecutor): void {
  registry.set(name, { definition, execute });
}

export function getTool(name: string): RegisteredTool | undefined {
  return registry.get(name);
}

export function getAllTools(): RegisteredTool[] {
  return Array.from(registry.values());
}

export function getToolDefinitions(): ToolDefinition[] {
  return getAllTools().map((t) => t.definition);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export const readTool: ToolExecutor = async (input, ctx) => {
  const filePath = resolve(ctx.cwd, input.file_path as string);
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const offset = ((input.offset as number) ?? 1) - 1; // 1-indexed to 0-indexed
    const limit = (input.limit as number) ?? lines.length;
    const slice = lines.slice(Math.max(0, offset), offset + limit);
    const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`).join("\n");
    return { output: numbered };
  } catch (e: any) {
    return { output: `Error reading ${filePath}: ${e.message}`, isError: true };
  }
};

registerTool("Read", {
  name: "Read",
  description: "Read a file. Returns content with line numbers. Use offset/limit for large files.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file" },
      offset: { type: "number", description: "Line number to start from (1-indexed)" },
      limit: { type: "number", description: "Number of lines to read" },
    },
    required: ["file_path"],
  },
}, readTool);

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export const writeTool: ToolExecutor = async (input, ctx) => {
  const filePath = resolve(ctx.cwd, input.file_path as string);
  const content = input.content as string;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
    const lineCount = content.split("\n").length;
    return { output: `Wrote ${lineCount} lines to ${filePath}` };
  } catch (e: any) {
    return { output: `Error writing ${filePath}: ${e.message}`, isError: true };
  }
};

registerTool("Write", {
  name: "Write",
  description: "Create or overwrite a file with the given content.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file" },
      content: { type: "string", description: "File content to write" },
    },
    required: ["file_path", "content"],
  },
}, writeTool);

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export const editTool: ToolExecutor = async (input, ctx) => {
  const filePath = resolve(ctx.cwd, input.file_path as string);
  const oldString = input.old_string as string;
  const newString = input.new_string as string;
  const replaceAll = (input.replace_all as boolean) ?? false;

  try {
    const content = readFileSync(filePath, "utf8");

    if (!replaceAll) {
      const firstIndex = content.indexOf(oldString);
      if (firstIndex === -1) {
        return { output: `Error: old_string not found in ${filePath}`, isError: true };
      }
      const secondIndex = content.indexOf(oldString, firstIndex + 1);
      if (secondIndex !== -1) {
        return { output: `Error: old_string is not unique in ${filePath}. Provide more context.`, isError: true };
      }
    } else {
      if (!content.includes(oldString)) {
        return { output: `Error: old_string not found in ${filePath}`, isError: true };
      }
    }

    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    writeFileSync(filePath, updated);
    return { output: `Edited ${filePath}` };
  } catch (e: any) {
    return { output: `Error editing ${filePath}: ${e.message}`, isError: true };
  }
};

registerTool("Edit", {
  name: "Edit",
  description: "Replace exact text in a file. old_string must be unique unless replace_all is true.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file" },
      old_string: { type: "string", description: "Exact text to find" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
}, editTool);

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

export const bashTool: ToolExecutor = async (input, ctx) => {
  const command = input.command as string;
  const timeout = ((input.timeout as number) ?? 120) * 1000;

  try {
    const proc = Bun.spawn(["sh", "-c", command], {
      cwd: ctx.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: ctx.env,
    });

    const timeoutId = setTimeout(() => proc.kill(), timeout);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    await proc.exited;
    clearTimeout(timeoutId);

    const exitCode = proc.exitCode ?? 1;
    const parts: string[] = [];
    if (stdout.trim()) parts.push(stdout.trim());
    if (stderr.trim()) parts.push(`STDERR:\n${stderr.trim()}`);
    if (exitCode !== 0) parts.push(`Exit code: ${exitCode}`);

    const output = parts.join("\n") || "(no output)";
    return { output: output.slice(0, 50000) };
  } catch (e: any) {
    return { output: `Error running command: ${e.message}`, isError: true };
  }
};

registerTool("Bash", {
  name: "Bash",
  description: "Run a shell command. Returns stdout, stderr, and exit code.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "number", description: "Timeout in seconds (default 120)" },
    },
    required: ["command"],
  },
}, bashTool);

// ---------------------------------------------------------------------------
// Glob
// ---------------------------------------------------------------------------

export const globTool: ToolExecutor = async (input, ctx) => {
  const pattern = input.pattern as string;
  const searchPath = input.path ? resolve(ctx.cwd, input.path as string) : ctx.cwd;

  try {
    const glob = new Bun.Glob(pattern);
    const matches: string[] = [];
    for await (const match of glob.scan({ cwd: searchPath, absolute: true })) {
      matches.push(match);
      if (matches.length >= 500) break;
    }
    matches.sort();
    return { output: matches.join("\n") || "(no matches)" };
  } catch (e: any) {
    return { output: `Error: ${e.message}`, isError: true };
  }
};

registerTool("Glob", {
  name: "Glob",
  description: "Find files matching a glob pattern. Returns matching file paths.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern (e.g., '**/*.ts')" },
      path: { type: "string", description: "Directory to search in (default: cwd)" },
    },
    required: ["pattern"],
  },
}, globTool);

// ---------------------------------------------------------------------------
// Grep
// ---------------------------------------------------------------------------

export const grepTool: ToolExecutor = async (input, ctx) => {
  const pattern = input.pattern as string;
  const searchPath = input.path ? resolve(ctx.cwd, input.path as string) : ctx.cwd;
  const outputMode = (input.output_mode as string) ?? "files_with_matches";
  const context = (input.context as number) ?? (input["-C"] as number) ?? 0;

  const args = ["rg", "--no-heading"];

  if (outputMode === "files_with_matches") {
    args.push("-l");
  } else if (outputMode === "count") {
    args.push("-c");
  } else {
    args.push("-n");
    if (context > 0) args.push("-C", String(context));
  }

  args.push(pattern, searchPath);

  try {
    const proc = Bun.spawn(args, {
      cwd: ctx.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: ctx.env,
    });

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    return { output: stdout.trim().slice(0, 50000) || "(no matches)" };
  } catch (e: any) {
    return { output: `Error: ${e.message}`, isError: true };
  }
};

registerTool("Grep", {
  name: "Grep",
  description: "Search file contents using ripgrep. Supports regex patterns.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "File or directory to search (default: cwd)" },
      output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Output format (default: files_with_matches)" },
      context: { type: "number", description: "Lines of context around matches (content mode only)" },
    },
    required: ["pattern"],
  },
}, grepTool);
