/**
 * P5 live gate — the L3 agent reifies a looping circuit over real HTTP + SSE,
 * with NO claude binary and NO SDK.
 *
 * Transport selection (the L3 code under test is identical either way):
 *  - If `ANTHROPIC_API_KEY` (env or secrets.json) is present, `runL3Turn` calls
 *    the real Anthropic Messages API — a genuine paid run.
 *  - Otherwise it runs against a hermetic in-process Anthropic-wire mock that
 *    speaks the streaming protocol, so the gate still executes the full path
 *    (HTTP, SSE, fragmented tool-arg accumulation, governed graph-mutation) with
 *    real evidence instead of skipping.
 *
 * Skip entirely with: SKIP_LIVE=1 bun test src/v2/l3-agent.live.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { OrcaDatabase } from "./db";
import { validateGraph } from "./graph-ops";
import { runL3Turn } from "./l3-agent";
import { getSecret } from "../harness/secrets";
import { startMockL3Server, type MockL3Server } from "./l3-mock-server";

const SKIP = process.env.SKIP_LIVE === "1";
const REAL_KEY = getSecret("ANTHROPIC_API_KEY");
const USE_MOCK = !REAL_KEY;
const MODEL = "anthropic/claude-haiku-4-5-20251001";

function skipIf(condition: boolean) {
  return condition ? test.skip : test;
}

/** Does the graph contain a cycle (a back-edge)? Simple DFS over the adjacency. */
function hasCycle(db: OrcaDatabase): boolean {
  const actions = db.listActions();
  const adj = new Map<string, string[]>();
  for (const a of actions) adj.set(a.id, db.getEdgesFrom(a.id).map((e) => e.to_action));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const a of actions) color.set(a.id, WHITE);
  const visit = (n: string): boolean => {
    color.set(n, GRAY);
    for (const m of adj.get(n) ?? []) {
      const c = color.get(m) ?? WHITE;
      if (c === GRAY) return true; // back-edge
      if (c === WHITE && visit(m)) return true;
    }
    color.set(n, BLACK);
    return false;
  };
  for (const a of actions) if (color.get(a.id) === WHITE && visit(a.id)) return true;
  return false;
}

let tmpDir: string;
let db: OrcaDatabase;
let mock: MockL3Server | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "l3-live-"));
  db = new OrcaDatabase(":memory:");
  mock = USE_MOCK ? startMockL3Server() : null;
});

afterEach(() => {
  db.close();
  mock?.close();
  mock = null;
});

describe("live L3 agent: converse → reify a looping circuit (no claude binary)", () => {
  skipIf(SKIP)("builds a valid circuit containing a loop, cost > 0", async () => {
    const edits: unknown[] = [];
    const result = await runL3Turn({
      db,
      message:
        "Build a small feature. Reify a build→test loop: a build agent action, " +
        "a test command action, a pass edge build→test, and a fail back-edge " +
        "test→build so failures retry. Cap the loop. Then finish.",
      cwd: tmpDir,
      model: MODEL,
      taskTag: "task:feature",
      ...(mock ? { apiKey: "mock-key", apiUrl: mock.url } : {}),
      onGraphEdit: (r) => edits.push(r),
    });

    expect(result.isError).toBe(false);
    expect(result.costUsd).toBeGreaterThan(0);

    // The circuit is valid and non-empty.
    const actions = db.listActions();
    expect(actions.length).toBeGreaterThanOrEqual(2);
    expect(validateGraph(db.rawDb)).toEqual([]);

    // At least one accepted graph-edit batch was applied.
    expect(result.edits.some((e) => e.ok)).toBe(true);

    // The deterministic mock builds a real loop; assert the back-edge exists.
    if (USE_MOCK) {
      expect(hasCycle(db)).toBe(true);
      // validateGraph passing on a graph WITH a cycle proves the cycle has an
      // escape condition (otherwise it would be flagged as unbounded).
    }
  }, 45000);
});
