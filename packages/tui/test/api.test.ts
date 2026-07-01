/**
 * Integration: the TUI client against a REAL in-process `orca serve` daemon,
 * exercising the P5 `/chat` seam end-to-end. An injected mock L3 runner applies
 * a real governed graph-edit (build↔test loop) and the daemon broadcasts the
 * braid over SSE; the store projects those events back into circuit rows —
 * proving spec-tui acceptance #2 across the wire.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { startServer } from "../../server/src/v2/server";
import { OrcaDatabase } from "../../server/src/v2/db";
import { createGraphEditTool } from "../../server/src/v2/l3-agent";
import type { L3TurnOptions, L3TurnResult } from "../../server/src/v2/l3-agent";
import { OrcaClient, parseFrame } from "../src/api";
import { applyEvent, seedActions } from "../src/store";
import { initialState } from "../src/types";
import type { SseEvent } from "../src/store";

const LOOP_EDITS = [
  { op: "add_action", id: "feat.build", type: "agent", prompt: "build", initial: true, max_iterations: 5 },
  { op: "add_action", id: "feat.test", type: "command", command: "bun test" },
  { op: "add_edge", from: "feat.build", to: "feat.test", condition: "pass" },
  { op: "add_edge", from: "feat.test", to: "feat.build", condition: "fail" },
];

// A mock L3 runner: narrates, applies the loop through the REAL governed tool,
// forwards each batch to onGraphEdit (as the server does), returns a result.
async function mockL3(opts: L3TurnOptions): Promise<L3TurnResult> {
  opts.onText?.("Reifying a build→test loop.");
  const edits: any[] = [];
  const tool = createGraphEditTool(opts.db, { taskTag: opts.taskTag }, (rec) => {
    edits.push(rec);
    opts.onGraphEdit?.(rec);
  });
  tool.execute({ edits: LOOP_EDITS }, { cwd: opts.cwd });
  return { output: { status: "passed", summary: "built loop" }, costUsd: 0.01, numTurns: 1, isError: false, edits };
}

let handle: ReturnType<typeof startServer>;
let baseUrl: string;

beforeEach(() => {
  const db = new OrcaDatabase(":memory:");
  handle = startServer({ port: 0, db, noExecutor: true, l3Runner: mockL3, l3: { cwd: "/tmp" } });
  baseUrl = `http://localhost:${handle.server.port}`;
});

afterEach(() => {
  clearInterval(handle.heartbeatInterval);
  handle.server.stop(true);
  handle.db.close();
});

describe("api: parseFrame", () => {
  test("parses an SSE frame into {event,data}", () => {
    const f = parseFrame("event: graph_edit\ndata: {\"ok\":true}");
    expect(f).toEqual({ event: "graph_edit", data: { ok: true } });
  });
  test("ignores heartbeat comments", () => {
    expect(parseFrame(": heartbeat")).toBeNull();
  });
});

describe("api: TUI ↔ daemon over REST + SSE", () => {
  test("health + empty actions on a fresh daemon", async () => {
    const client = new OrcaClient(baseUrl);
    const health = await client.health();
    expect(health.version).toBe("2.0.0");
    expect(await client.getActions()).toEqual([]);
  });

  test("a chat message routes to L3; its mutation streams back and lands in the circuit", async () => {
    const client = new OrcaClient(baseUrl);
    const received: SseEvent[] = [];
    const conn = client.connectEvents((e) => received.push(e));

    // Let the SSE handshake land, then converse.
    await Bun.sleep(50);
    const resp = await client.chat("build a feature with a retry loop");
    expect(resp.status).toBe("accepted");
    expect(resp.message_id).toBeTruthy();

    // Wait for the braid to arrive.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !received.some((e) => e.event === "l3_result")) {
      await Bun.sleep(20);
    }
    conn.detach();

    const kinds = received.map((e) => e.event);
    expect(kinds).toContain("l3_message");
    expect(kinds).toContain("graph_edit");
    expect(kinds).toContain("l3_result");

    // Project the received events through the store → circuit rows appear.
    let s = initialState("demo");
    for (const e of received) s = applyEvent(s, e);
    expect(s.hasCircuit).toBe(true);
    expect(s.order).toContain("feat.build");
    expect(s.actions["feat.build"].successors).toContain("feat.test");
    expect(s.actions["feat.test"].successors).toContain("feat.build"); // back-edge

    // The daemon actually persisted the circuit (getActions reflects it).
    const actions = await client.getActions();
    const ids = actions.map((a) => a.id).sort();
    expect(ids).toEqual(["feat.build", "feat.test"]);

    // Seeding from REST agrees with the streamed projection.
    let s2 = seedActions(initialState("demo"), actions);
    expect(s2.order.sort()).toEqual(["feat.build", "feat.test"]);
  });
});
