/**
 * P5 gate — L3 primary agent (loopcraft).
 *
 * Drives `runL3Turn` against an in-process scripted `ModelProvider` (no HTTP, no
 * key) so the whole path — Layer B loop → injected graph-mutation tool → P4
 * governed chokepoint — is exercised deterministically. Asserts a conversation
 * reifies a VALID looping circuit and that an invalid mutation is rejected by
 * governance.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { OrcaDatabase } from "./db";
import { validateGraph } from "./graph-ops";
import { runL3Turn, type GraphEdit } from "./l3-agent";
import { ModelRegistry } from "../models/registry";
import type { ModelProvider, ModelCapabilities } from "../models/provider";
import type { ModelDelta, ModelMessage, ToolSchema } from "../models/types";
import type { StreamOptions } from "../models/provider";

// ---------------------------------------------------------------------------
// Scripted provider — a deterministic "model" that emits a fixed tool plan
// ---------------------------------------------------------------------------

const CAPS: ModelCapabilities = {
  structuredOutput: true,
  parallelToolCalls: false,
  vision: false,
  promptCaching: false,
  maxContextTokens: 200000,
};

function applyAlreadyDone(messages: ModelMessage[]): boolean {
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_call" && b.name === "apply_graph_edits") return true;
    }
  }
  return false;
}

/** A provider that, on its first turn, calls apply_graph_edits(edits); on the
 *  next, finalizes with StructuredOutput. Honors a forced output tool. */
function scriptedProvider(edits: GraphEdit[]): ModelProvider {
  return {
    id: "fake",
    capabilities: CAPS,
    supports: () => true,
    async *stream(
      messages: ModelMessage[],
      _tools: ToolSchema[],
      opts: StreamOptions,
    ): AsyncIterable<ModelDelta> {
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } };

      const forced = typeof opts.toolChoice === "object" ? opts.toolChoice.name : undefined;
      if (forced) {
        yield { type: "tool_call", toolCall: { id: "out", name: forced, input: { status: "passed", summary: "circuit built" } } };
        yield { type: "stop", reason: "tool_use" };
        return;
      }

      if (!applyAlreadyDone(messages)) {
        yield { type: "text", text: "Reifying a build→test loop." };
        yield { type: "tool_call", toolCall: { id: "e1", name: "apply_graph_edits", input: { edits } } };
        yield { type: "stop", reason: "tool_use" };
        return;
      }

      yield { type: "tool_call", toolCall: { id: "out", name: "StructuredOutput", input: { status: "passed", summary: "circuit built" } } };
      yield { type: "stop", reason: "tool_use" };
    },
  };
}

/** Did the transcript already contain a tool_call with this name? */
function toolCalled(messages: ModelMessage[], name: string): boolean {
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_call" && b.name === name) return true;
    }
  }
  return false;
}

/**
 * A provider that RECONS first (reads a file) then ACTS (apply_graph_edits) then
 * finalizes. Records the tool schemas it was offered into `seenTools` so a test
 * can assert the recon toolset is present and no write tools leaked in.
 */
function reconThenBuildProvider(
  filePath: string,
  edits: GraphEdit[],
  seenTools: string[],
): ModelProvider {
  return {
    id: "fake",
    capabilities: CAPS,
    supports: () => true,
    async *stream(
      messages: ModelMessage[],
      tools: ToolSchema[],
      opts: StreamOptions,
    ): AsyncIterable<ModelDelta> {
      seenTools.push(...tools.map((t) => t.name));
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } };

      const forced = typeof opts.toolChoice === "object" ? opts.toolChoice.name : undefined;
      if (forced) {
        yield { type: "tool_call", toolCall: { id: "out", name: forced, input: { status: "passed", summary: "built" } } };
        yield { type: "stop", reason: "tool_use" };
        return;
      }

      if (!toolCalled(messages, "Read")) {
        yield { type: "text", text: "Reconning the workspace first." };
        yield { type: "tool_call", toolCall: { id: "r1", name: "Read", input: { file_path: filePath } } };
        yield { type: "stop", reason: "tool_use" };
        return;
      }

      if (!toolCalled(messages, "apply_graph_edits")) {
        yield { type: "text", text: "Grounded — reifying the loop." };
        yield { type: "tool_call", toolCall: { id: "e1", name: "apply_graph_edits", input: { edits } } };
        yield { type: "stop", reason: "tool_use" };
        return;
      }

      yield { type: "tool_call", toolCall: { id: "out", name: "StructuredOutput", input: { status: "passed", summary: "built" } } };
      yield { type: "stop", reason: "tool_use" };
    },
  };
}

function registryFor(provider: ModelProvider): ModelRegistry {
  const registry = new ModelRegistry("fake/model");
  registry.registerProvider(provider);
  registry.registerModel({
    id: "fake/model",
    provider,
    apiModel: "model",
    price: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    capabilities: provider.capabilities,
  });
  return registry;
}

// The minimal legal loop: build↔test with a back-edge and a terminal escape
// (test has no `pass` edge, so a passing test exits the loop).
const LOOP_EDITS: GraphEdit[] = [
  { op: "add_action", id: "demo.build", type: "agent", prompt: "Write the feature", initial: true, max_iterations: 5 },
  { op: "add_action", id: "demo.test", type: "command", command: "bun test" },
  { op: "add_edge", from: "demo.build", to: "demo.test", condition: "pass" },
  { op: "add_edge", from: "demo.test", to: "demo.build", condition: "fail" },
];

let tmpDir: string;
let db: OrcaDatabase;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "l3-agent-"));
  db = new OrcaDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------

describe("L3 agent: converse → reify a looping circuit", () => {
  test("a conversation produces a valid circuit with a back-edge and an escape", async () => {
    const provider = scriptedProvider(LOOP_EDITS);
    const texts: string[] = [];

    const result = await runL3Turn({
      db,
      message: "Build a feature with a build→test retry loop.",
      cwd: tmpDir,
      model: "fake/model",
      registry: registryFor(provider),
      taskTag: "task:demo",
      onText: (t) => texts.push(t),
    });

    // The turn completed and reified edits.
    expect(result.isError).toBe(false);
    expect(result.output?.status).toBe("passed");
    expect(result.edits.length).toBe(1);
    expect(result.edits[0].ok).toBe(true);
    expect(texts.join("")).toContain("loop");

    // The circuit is valid.
    expect(validateGraph(db.rawDb)).toEqual([]);

    // Both actions exist, entry is schedulable, tagged to the task.
    const build = db.getAction("demo.build")!;
    const testA = db.getAction("demo.test")!;
    expect(build.status).toBe("pending"); // marked initial
    expect(testA.status).toBe("inactive");
    expect(build.tags).toContain("task:demo");
    expect(build.params.max_iterations).toBe(5);

    // There IS a back-edge forming a cycle (build↔test) with an escape:
    // build--pass-->test and test--fail-->build; test has no pass edge so a
    // passing test exits the loop.
    const buildEdges = db.getEdgesFrom("demo.build");
    const testEdges = db.getEdgesFrom("demo.test");
    expect(buildEdges).toContainEqual(expect.objectContaining({ to_action: "demo.test", condition: "pass" }));
    expect(testEdges).toContainEqual(expect.objectContaining({ to_action: "demo.build", condition: "fail" }));
    expect(testEdges.some((e) => e.condition === "pass")).toBe(false); // terminal escape
  });

  test("an invalid mutation (unbounded cycle) is rejected by P4 governance", async () => {
    // build↔test where test--pass-->build too: every pass routes back in, no
    // escape → an illegal unbounded cycle.
    const badEdits: GraphEdit[] = [
      { op: "add_action", id: "bad.build", type: "agent", prompt: "x", initial: true },
      { op: "add_action", id: "bad.test", type: "agent", prompt: "y" },
      { op: "add_edge", from: "bad.build", to: "bad.test", condition: "pass" },
      { op: "add_edge", from: "bad.test", to: "bad.build", condition: "pass" },
    ];

    const result = await runL3Turn({
      db,
      message: "Build a loop with no escape.",
      cwd: tmpDir,
      model: "fake/model",
      registry: registryFor(scriptedProvider(badEdits)),
    });

    // Governance rejected the batch; the graph is untouched.
    expect(result.edits.length).toBe(1);
    expect(result.edits[0].ok).toBe(false);
    expect(result.edits[0].issues.join(" ")).toContain("Unbounded cycle");
    expect(db.getAction("bad.build")).toBeNull();
    expect(db.getAction("bad.test")).toBeNull();
    // The turn itself still completes (the agent got the rejection as a result).
    expect(result.isError).toBe(false);
  });
});

describe("CG1: read-only recon tools alongside apply_graph_edits", () => {
  test("the planner is offered Read/Grep/Glob + apply_graph_edits, but no Write/Edit/Bash", async () => {
    const seenTools: string[] = [];
    const provider = reconThenBuildProvider(join(tmpDir, "spec.txt"), LOOP_EDITS, seenTools);

    await runL3Turn({
      db,
      message: "Recon then build.",
      cwd: tmpDir,
      model: "fake/model",
      registry: registryFor(provider),
      taskTag: "task:demo",
    });

    // Recon toolset present alongside the mutation tool...
    expect(seenTools).toContain("Read");
    expect(seenTools).toContain("Grep");
    expect(seenTools).toContain("Glob");
    expect(seenTools).toContain("apply_graph_edits");
    // ...and NO write/edit/bash tools (acting stays mutation-only).
    expect(seenTools).not.toContain("Write");
    expect(seenTools).not.toContain("Edit");
    expect(seenTools).not.toContain("Bash");
  });

  test("an L3 turn can actually Read a file, then reify a valid circuit", async () => {
    const specPath = join(tmpDir, "spec.txt");
    writeFileSync(specPath, "ENTRY POINT: src/server.ts\n");
    const seenTools: string[] = [];
    const provider = reconThenBuildProvider(specPath, LOOP_EDITS, seenTools);

    const result = await runL3Turn({
      db,
      message: "Recon then build.",
      cwd: tmpDir,
      model: "fake/model",
      registry: registryFor(provider),
      taskTag: "task:demo",
    });

    // The recon call executed (a real Read tool ran) AND the mutation landed.
    expect(result.isError).toBe(false);
    expect(result.output?.status).toBe("passed");
    expect(result.edits.length).toBe(1);
    expect(result.edits[0].ok).toBe(true);

    // The circuit is valid and both actions exist.
    expect(validateGraph(db.rawDb)).toEqual([]);
    expect(db.getAction("demo.build")!.status).toBe("pending");
    expect(db.getAction("demo.test")!.status).toBe("inactive");
  });
});
