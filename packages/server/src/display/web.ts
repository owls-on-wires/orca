/**
 * Web monitor — serves a dashboard for watching builds.
 *
 * Replaces the TUI monitor with a browser-based UI.
 * Uses Bun.serve() with WebSocket for live state updates.
 */

import { existsSync, readFileSync, watch, readdirSync, unlinkSync } from "fs";
import { join, resolve, dirname } from "path";
import * as yaml from "js-yaml";
import { getOrcaDir } from "../state";
import type { OrcaConfig } from "../config/schema";
import { validateConfig, loadTasks } from "../config/loader";

// @ts-ignore — import with text type for compiled binary embedding
import monitorHtml from "../web/monitor.html" with { type: "text" };

const PORT = 7070;

export function startWebMonitor(configPath: string): Promise<void> {
  if (!existsSync(configPath)) {
    console.error(`File not found: ${configPath}`);
    process.exit(1);
  }

  const raw = readFileSync(configPath, "utf8");
  const data = yaml.load(raw);
  if (!validateConfig(data)) {
    console.error("Invalid config");
    process.exit(1);
  }
  const config = data as OrcaConfig;
  const projectDir = resolve(dirname(configPath), config.project_dir ?? ".");
  const orcaDir = getOrcaDir(projectDir);
  const runsDir = join(orcaDir, "runs", config.name);

  // Load task list for pending task display
  let allTaskIds: string[] = [];
  loadTasks(config, configPath)
    .then(tasks => { allTaskIds = tasks.map(t => t.id); })
    .catch(() => {});

  // Track WebSocket clients
  const clients = new Set<any>();

  function readState(): Record<string, unknown> | null {
    if (!existsSync(runsDir)) return null;
    const runDirs = readdirSync(runsDir).sort();
    if (runDirs.length === 0) return null;
    const latestDir = join(runsDir, runDirs[runDirs.length - 1]);
    const statePath = join(latestDir, "state.json");
    if (!existsSync(statePath)) return null;
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8"));

      // Detect crashed/aborted detached process
      if (state.status === "running") {
        const pidPath = join(orcaDir, "build.pid");
        if (!existsSync(pidPath)) {
          // No PID file but state says running = crashed or aborted
          state.status = "crashed";
        } else {
          const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
          if (!isNaN(pid)) {
            try { process.kill(pid, 0); } catch {
              state.status = "crashed";
              try { unlinkSync(pidPath); } catch {}
            }
          }
        }
      }

      // Inject extra info for the dashboard
      const stateTaskCount = Object.keys(state.tasks || {}).length;
      state._totalTasks = Math.max(allTaskIds.length, stateTaskCount);
      state._pendingTasks = allTaskIds;
      state._workflow = config.workflow;

      // Check for intervention
      const interventionPath = join(orcaDir, "intervention.json");
      if (existsSync(interventionPath)) {
        try {
          state._intervention = JSON.parse(readFileSync(interventionPath, "utf8"));
        } catch {}
      }

      // Recent log entries for current task
      if (state.currentTaskId) {
        state._recentLog = readRecentLog(orcaDir, state.currentTaskId, state.tasks?.[state.currentTaskId]?.currentStage);
      }

      return state;
    } catch {
      return null;
    }
  }

  function readRecentLog(orcaDir: string, taskId: string, stage?: string | null): unknown[] {
    if (!stage) return [];
    const logPath = join(orcaDir, "tasks", taskId, `${stage}.jsonl`);
    if (!existsSync(logPath)) return [];
    try {
      const content = readFileSync(logPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      // Return last 20 entries
      return lines.slice(-20).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  function broadcast() {
    const state = readState();
    if (!state) return;
    const json = JSON.stringify(state);
    for (const ws of clients) {
      try { ws.send(json); } catch { clients.delete(ws); }
    }
  }

  // Watch for state changes
  try {
    if (existsSync(runsDir)) {
      watch(runsDir, { recursive: true }, () => broadcast());
    } else {
      // Watch orca dir for the runs dir to appear
      if (existsSync(orcaDir)) {
        watch(orcaDir, { recursive: true }, () => broadcast());
      }
    }
  } catch {}

  // Poll as backup
  setInterval(broadcast, 2000);

  const server = Bun.serve({
    port: PORT,
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (url.pathname === "/api/state") {
        const state = readState();
        if (!state) {
          return new Response(JSON.stringify({ status: "waiting", name: config.name }), {
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          });
        }
        return new Response(JSON.stringify(state), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      // Serve the dashboard
      return new Response(monitorHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        const state = readState();
        if (state) ws.send(JSON.stringify(state));
      },
      close(ws) { clients.delete(ws); },
      message() {},
    },
  });

  console.log(`\norca monitor: http://localhost:${PORT}`);
  console.log(`  Build: ${config.name}`);
  console.log(`  Watching: ${runsDir}\n`);

  // Open browser
  try {
    Bun.spawn(["xdg-open", `http://localhost:${PORT}`], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {}

  // Block until SIGINT/SIGTERM
  return new Promise<void>((resolve) => {
    const cleanup = () => {
      server.stop();
      resolve();
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  });
}
