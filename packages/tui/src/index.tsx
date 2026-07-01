/**
 * `orca` (TUI) entry point.
 *
 * "Just run orca": if no daemon is reachable, auto-start one, then attach over
 * REST + SSE. Quitting (`q`) drops the connection and exits the CLIENT — the
 * daemon (and the build) keeps running, because the daemon is a separate,
 * unref'd process that owns all build state. Re-running `orca` re-attaches.
 */

import React from "react";
import { render } from "ink";
import { resolve } from "path";
import { homedir } from "os";
import { InteractiveApp } from "./app";
import { OrcaClient } from "./api";

interface Args {
  url?: string;
  port: number;
  db: string;
  name: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    port: 7070,
    db: resolve(homedir(), ".orca/orca.db"),
    name: "orca",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" && argv[i + 1]) out.url = argv[++i];
    else if (a === "--port" && argv[i + 1]) out.port = parseInt(argv[++i], 10);
    else if (a === "--db" && argv[i + 1]) out.db = argv[++i];
    else if (a === "--name" && argv[i + 1]) out.name = argv[++i];
  }
  return out;
}

async function isUp(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Spawn the daemon detached so it outlives this client, then wait for health. */
async function ensureDaemon(baseUrl: string, args: Args): Promise<void> {
  if (await isUp(baseUrl)) return;

  const serverEntry = resolve(import.meta.dir, "../../server/src/v2/server.ts");
  const child = Bun.spawn(
    ["bun", "run", serverEntry, "--port", String(args.port), "--db", args.db],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  child.unref(); // let it outlive us — the build must survive detach

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await isUp(baseUrl)) return;
    await Bun.sleep(150);
  }
  throw new Error(`daemon did not come up on ${baseUrl}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args.url ?? `http://localhost:${args.port}`;

  await ensureDaemon(baseUrl, args);

  const client = new OrcaClient(baseUrl);
  const { waitUntilExit } = render(
    <InteractiveApp client={client} buildName={args.name} onDetach={() => { /* daemon keeps running */ }} />,
  );
  await waitUntilExit();
  // Client exits; daemon (and build) keeps running.
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
