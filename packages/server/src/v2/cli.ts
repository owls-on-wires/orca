#!/usr/bin/env bun
/**
 * orca-v2 CLI entry point.
 * Compilable: bun build src/v2/cli.ts --compile --outfile bin/orca-v2
 */

import { readFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { OrcaDatabase } from "./db";
import { expandConfig } from "./config";
import { Executor } from "./executor";
import { startServer } from "./server";
import type { ActionConfig, ActionStatus } from "./schema";
import { runAction } from "./action-runner";

const VERSION = "2.0.0";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // skip bun/node + script
  const command = args[0] ?? "";
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

// Also handle top-level --version / --help before command
export function parseTopLevel(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  // Check for --version / --help as first arg
  if (args.length === 0 || args[0] === "--help") {
    return { command: "help", positional: [], flags: {} };
  }
  if (args[0] === "--version") {
    return { command: "version", positional: [], flags: {} };
  }
  return parseArgs(argv);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDbPath(flags: Record<string, string | boolean>): string {
  const p = typeof flags.db === "string" ? flags.db : ".orca/orca.db";
  // Ensure parent directory exists
  try {
    mkdirSync(dirname(p), { recursive: true });
  } catch { /* already exists */ }
  return p;
}

function loadYaml(path: string): string {
  return readFileSync(path, "utf-8");
}

function printHelp(): void {
  console.log(`orca-v2 ${VERSION}

Usage:
  orca-v2 serve [--port PORT] [--db PATH]
  orca-v2 run <config.yaml> [--db PATH]
  orca-v2 import <config.yaml> [--db PATH]
  orca-v2 status [--db PATH] [--tag TAG]
  orca-v2 actions [--db PATH] [--tag TAG] [--status STATUS]
  orca-v2 pause [--server URL]
  orca-v2 resume [--server URL]
  orca-v2 respond <action-id> <status> [--notes "..."] [--server URL]
  orca-v2 --version
  orca-v2 --help`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdServe(flags: Record<string, string | boolean>): Promise<void> {
  const port = typeof flags.port === "string" ? parseInt(flags.port, 10) : 7070;
  const dbPath = resolveDbPath(flags);
  const { server } = startServer({ port, dbPath });
  console.log(`Orca v2 server listening on http://localhost:${server.port}`);
}

async function cmdRun(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const configPath = positional[0];
  if (!configPath) {
    console.error("Error: config file required. Usage: orca-v2 run <config.yaml>");
    process.exit(1);
  }

  const dbPath = resolveDbPath(flags);
  const yamlString = loadYaml(configPath);
  const sourceDir = dirname(require("path").resolve(configPath));
  const db = new OrcaDatabase(dbPath);

  let config;
  try {
    config = expandConfig(yamlString, db, sourceDir);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error loading config: ${msg}`);
    db.close();
    process.exit(1);
  }

  const projectDir = config.project_dir ?? ".";

  console.log(`Loaded ${db.listActions().length} actions from ${configPath}`);

  const executor = new Executor(db, {
    projectDir,
    model: config.model,
    runActionFn: runAction,
    onActionStart: (action: ActionConfig) => {
      console.log(`▶ ${action.id} [${action.type}] started`);
    },
    onActionEnd: (action: ActionConfig, result) => {
      console.log(`✓ ${action.id} → ${result.condition} ($${result.cost_usd.toFixed(4)})`);
    },
    onActionWaiting: (action: ActionConfig) => {
      console.log(`⏸ ${action.id} waiting for response`);
    },
    onEdgeTraversed: (from: string, to: string, condition: string) => {
      console.log(`  ${from} ─[${condition}]→ ${to}`);
    },
    onIdle: () => {
      console.log("Executor idle — all actions processed.");
    },
  });

  await executor.run();
  db.close();
}

async function cmdImport(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const configPath = positional[0];
  if (!configPath) {
    console.error("Error: config file required. Usage: orca-v2 import <config.yaml>");
    process.exit(1);
  }

  const dbPath = resolveDbPath(flags);
  const yamlString = loadYaml(configPath);
  const sourceDir = dirname(require("path").resolve(configPath));
  const db = new OrcaDatabase(dbPath);

  try {
    expandConfig(yamlString, db, sourceDir);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error loading config: ${msg}`);
    db.close();
    process.exit(1);
  }

  const actions = db.listActions();
  let edgeCount = 0;
  for (const a of actions) {
    edgeCount += db.getEdgesFrom(a.id).length;
  }

  console.log(`Imported ${actions.length} actions and ${edgeCount} edges into ${dbPath}`);
  db.close();
}

function cmdStatus(flags: Record<string, string | boolean>): void {
  const dbPath = resolveDbPath(flags);
  const db = new OrcaDatabase(dbPath);
  const tag = typeof flags.tag === "string" ? flags.tag : undefined;

  const actions = db.listActions(tag ? { tag } : undefined);

  const counts: Record<string, number> = {
    total: 0,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    waiting: 0,
    inactive: 0,
    skipped: 0,
  };

  const tagCosts: Record<string, number> = {};

  for (const a of actions) {
    counts.total++;
    counts[a.status] = (counts[a.status] ?? 0) + 1;

    // Per-tag cost breakdown
    for (const t of a.tags) {
      tagCosts[t] = (tagCosts[t] ?? 0) + a.cost_usd;
    }
  }

  // Active action
  const running = actions.find((a) => a.status === "running");

  console.log("Status:");
  console.log(`  Total:     ${counts.total}`);
  console.log(`  Pending:   ${counts.pending}`);
  console.log(`  Running:   ${counts.running}`);
  console.log(`  Completed: ${counts.completed}`);
  console.log(`  Failed:    ${counts.failed}`);
  console.log(`  Waiting:   ${counts.waiting}`);
  console.log(`  Inactive:  ${counts.inactive}`);

  if (running) {
    console.log(`  Active:    ${running.id}`);
  }

  // Tag cost breakdown
  const costEntries = Object.entries(tagCosts).filter(([_, v]) => v > 0);
  if (costEntries.length > 0) {
    console.log("\nCost by tag:");
    for (const [t, cost] of costEntries.sort((a, b) => b[1] - a[1])) {
      console.log(`  ${t}: $${cost.toFixed(4)}`);
    }
  }

  db.close();
}

function cmdActions(flags: Record<string, string | boolean>): void {
  const dbPath = resolveDbPath(flags);
  const db = new OrcaDatabase(dbPath);
  const tag = typeof flags.tag === "string" ? flags.tag : undefined;
  const status = typeof flags.status === "string" ? flags.status as ActionStatus : undefined;

  const actions = db.listActions({ tag, status });

  if (actions.length === 0) {
    console.log("No actions found.");
  } else {
    for (const a of actions) {
      const cost = a.cost_usd > 0 ? ` $${a.cost_usd.toFixed(4)}` : "";
      console.log(`${a.id}  ${a.status}  ${a.type}${cost}`);
    }
  }

  db.close();
}

async function cmdPause(flags: Record<string, string | boolean>): Promise<void> {
  const server = typeof flags.server === "string" ? flags.server : "http://localhost:7070";
  try {
    const res = await fetch(`${server}/executor/pause`, { method: "POST" });
    const data = await res.json() as Record<string, unknown>;
    console.log(`Executor state: ${data.state}`);
  } catch (e: unknown) {
    console.error(`Error: could not reach server at ${server}`);
    process.exit(1);
  }
}

async function cmdResume(flags: Record<string, string | boolean>): Promise<void> {
  const server = typeof flags.server === "string" ? flags.server : "http://localhost:7070";
  try {
    const res = await fetch(`${server}/executor/resume`, { method: "POST" });
    const data = await res.json() as Record<string, unknown>;
    console.log(`Executor state: ${data.state}`);
  } catch (e: unknown) {
    console.error(`Error: could not reach server at ${server}`);
    process.exit(1);
  }
}

async function cmdRespond(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const actionId = positional[0];
  const status = positional[1];

  if (!actionId || !status) {
    console.error("Error: usage: orca-v2 respond <action-id> <status> [--notes \"...\"] [--server URL]");
    process.exit(1);
  }

  const server = typeof flags.server === "string" ? flags.server : "http://localhost:7070";
  const notes = typeof flags.notes === "string" ? flags.notes : undefined;

  const body: Record<string, unknown> = { status };
  if (notes) body.notes = notes;

  try {
    const res = await fetch(`${server}/actions/${encodeURIComponent(actionId)}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json() as Record<string, unknown>;
    console.log(`Response: ${data.status} (condition: ${data.condition})`);
  } catch (e: unknown) {
    console.error(`Error: could not reach server at ${server}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  const parsed = parseTopLevel(argv);
  const { command, positional, flags } = parsed;

  switch (command) {
    case "version":
      console.log(`orca-v2 ${VERSION}`);
      break;
    case "help":
      printHelp();
      break;
    case "serve":
      await cmdServe(flags);
      break;
    case "run":
      await cmdRun(positional, flags);
      break;
    case "import":
      await cmdImport(positional, flags);
      break;
    case "status":
      cmdStatus(flags);
      break;
    case "actions":
      cmdActions(flags);
      break;
    case "pause":
      await cmdPause(flags);
      break;
    case "resume":
      await cmdResume(flags);
      break;
    case "respond":
      await cmdRespond(positional, flags);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  main(process.argv).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
