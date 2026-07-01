/**
 * P6 gate — "detach without stopping the build".
 *
 * The TUI is a thin client of the `orca serve` daemon: it attaches over SSE and
 * detaches by dropping the connection. This proves the load-bearing contract —
 * a client attaching AND THEN disconnecting mid-build does NOT stop the
 * executor; the daemon keeps running the circuit to completion and stays
 * healthy. (spec-tui acceptance #1 / open-question-definition-of-done-daemon.)
 */

import { describe, test, expect } from "bun:test";
import { startServer, broadcast, type SSEEventType } from "./server";
import { OrcaDatabase } from "./db";
import { Executor } from "./executor";
import { createMockAgent } from "./mock-agent";
import { createAction, createEdge } from "./schema";

/** Stream SSE frames into `sink` live (so the caller can observe mid-flight),
 *  resolving when the stream ends (on detach/abort). */
async function streamFrames(baseUrl: string, signal: AbortSignal, sink: string[]): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/events`, { signal, headers: { Accept: "text/event-stream" } });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        sink.push(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
    }
  } catch {
    // aborted — expected on detach
  }
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(10);
  }
  return pred();
}

describe("TUI detach: the build keeps running after the client disconnects", () => {
  test("attach → detach mid-build → executor still completes the circuit", async () => {
    const db = new OrcaDatabase(":memory:");

    // A 5-node chain, each action ~60ms → ~300ms of work.
    const ids = ["s0", "s1", "s2", "s3", "s4"];
    ids.forEach((id, i) =>
      db.insertAction(createAction({ id, type: "agent", status: i === 0 ? "pending" : "inactive" })),
    );
    for (let i = 0; i < ids.length - 1; i++) db.insertEdge(createEdge(ids[i], ids[i + 1], "pass"));

    const { fn } = createMockAgent({
      sequence: ids.map(() => "pass" as const),
      minLatencyMs: 60,
      maxLatencyMs: 60,
      minCost: 0.01,
      maxCost: 0.01,
    });

    // Late-bound emit so the executor can broadcast to whatever the server wires.
    let emit: (t: SSEEventType, d: Record<string, unknown>, id?: string) => void = () => {};
    const executor = new Executor(db, {
      projectDir: "/tmp",
      runActionFn: fn,
      onActionStart: (a) => emit("action_started", { action_id: a.id }, a.id),
      onActionEnd: (a) => emit("action_completed", { action_id: a.id }, a.id),
    });

    const handle = startServer({ port: 0, db, executor, noExecutor: true });
    const baseUrl = `http://localhost:${handle.server.port}`;
    emit = (t, d, id) => broadcast(handle.state, t, d, id);

    try {
      // Attach an SSE client (frames stream into `frames` live).
      const controller = new AbortController();
      const frames: string[] = [];
      const streamDone = streamFrames(baseUrl, controller.signal, frames);

      // Kick off the build (the daemon's executor loop).
      const buildDone = executor.run();

      // Wait until the client has provably attached (received the connection
      // event), then DETACH — deterministically mid-build, not on a fixed timer.
      const attached = await waitFor(() => frames.some((f) => f.includes("connected")), 3000);
      const completedAtDetach = db.listActions().filter((a) => a.status === "completed").length;
      controller.abort();
      await streamDone;

      // The client attached…
      expect(attached).toBe(true);
      // …and detached before the build finished.
      expect(completedAtDetach).toBeLessThan(ids.length);

      // The build keeps running to completion despite the detach.
      await buildDone;
      const completed = db.listActions().filter((a) => a.status === "completed");
      expect(completed.length).toBe(ids.length);
      expect(executor.isIdle()).toBe(true);

      // The daemon is still healthy and serving after the client left.
      const health = (await (await fetch(`${baseUrl}/health`)).json()) as Record<string, unknown>;
      expect(health.version).toBe("2.0.0");
    } finally {
      clearInterval(handle.heartbeatInterval);
      handle.server.stop(true);
      db.close();
    }
  }, 15000);
});
