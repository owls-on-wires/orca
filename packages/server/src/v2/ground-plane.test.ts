/**
 * CG2 — the ground plane: a durable shared context store, an L3 tool that
 * writes it, and injection into an agent action's effective context at run time.
 *
 * The ground plane is the "shared, referenced" channel of a task's context
 * (see kbase/vision/context-as-graph.md): global facts live in one place and
 * are injected at run time, so per-task prompts stay specific.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { OrcaDatabase } from "./db";
import { createAction, createEdge, createProject } from "./schema";
import { Executor } from "./executor";
import { buildGroundPlanePrompt } from "./action-runner";
import {
  createGroundPlaneTool,
  runL3Turn,
  MAX_GROUND_PLANE_VALUE_CHARS,
} from "./l3-agent";
import { ModelRegistry } from "../models/registry";
import type { ModelProvider, ModelCapabilities } from "../models/provider";
import type { ModelDelta, ModelMessage, ToolSchema } from "../models/types";
import type { StreamOptions } from "../models/provider";
import type { RunActionFn } from "./executor";

const CAPS: ModelCapabilities = {
  structuredOutput: true,
  parallelToolCalls: false,
  vision: false,
  promptCaching: false,
  maxContextTokens: 200000,
};

/** A provider that calls set_ground_plane once, then finalizes. */
function groundPlaneWriter(key: string, value: string): ModelProvider {
  return {
    id: "fake",
    capabilities: CAPS,
    supports: () => true,
    async *stream(
      messages: ModelMessage[],
      _tools: ToolSchema[],
      opts: StreamOptions,
    ): AsyncIterable<ModelDelta> {
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      const forced = typeof opts.toolChoice === "object" ? opts.toolChoice.name : undefined;
      if (forced) {
        yield { type: "tool_call", toolCall: { id: "out", name: forced, input: { status: "passed", summary: "done" } } };
        yield { type: "stop", reason: "tool_use" };
        return;
      }
      const wrote = messages.some(
        (m) => m.role === "assistant" && Array.isArray(m.content) &&
          m.content.some((b) => b.type === "tool_call" && b.name === "set_ground_plane"),
      );
      if (!wrote) {
        yield { type: "tool_call", toolCall: { id: "g1", name: "set_ground_plane", input: { key, value } } };
        yield { type: "stop", reason: "tool_use" };
        return;
      }
      yield { type: "tool_call", toolCall: { id: "out", name: "StructuredOutput", input: { status: "passed", summary: "done" } } };
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

let db: OrcaDatabase;
let tmpDir: string;

beforeEach(() => {
  db = new OrcaDatabase(":memory:");
  tmpDir = mkdtempSync(join(tmpdir(), "ground-plane-"));
});

afterEach(() => {
  db.close();
});

describe("CG2: ground-plane store (db)", () => {
  test("set/get round-trip for a global entry", () => {
    db.setGroundPlane("spec", "Build a todo API", { source: "l3" });
    expect(db.getGroundPlane("spec")).toBe("Build a todo API");
  });

  test("upsert overwrites an existing key", () => {
    db.setGroundPlane("spec", "v1");
    db.setGroundPlane("spec", "v2");
    expect(db.getGroundPlane("spec")).toBe("v2");
    // A single row, not two.
    expect(db.listGroundPlane().filter((e) => e.key === "spec").length).toBe(1);
  });

  test("project-scoped entry shadows a global entry with the same key", () => {
    db.setGroundPlane("test-cmd", "bun test", {}); // global
    db.setGroundPlane("test-cmd", "npm test", { projectId: "proj-a" });
    expect(db.getGroundPlane("test-cmd")).toBe("bun test"); // no project → global
    expect(db.getGroundPlane("test-cmd", "proj-a")).toBe("npm test"); // scoped wins
    expect(db.getGroundPlane("test-cmd", "proj-b")).toBe("bun test"); // other proj → global
  });

  test("listGroundPlane merges global + project (project overrides), sorted", () => {
    db.setGroundPlane("a", "global-a");
    db.setGroundPlane("z", "global-z");
    db.setGroundPlane("a", "proj-a", { projectId: "p" });
    db.setGroundPlane("m", "proj-m", { projectId: "p" });

    const forP = db.listGroundPlane("p");
    expect(forP.map((e) => e.key)).toEqual(["a", "m", "z"]); // sorted
    expect(forP.find((e) => e.key === "a")!.value).toBe("proj-a"); // overridden
    expect(forP.find((e) => e.key === "z")!.value).toBe("global-z"); // global visible

    // Without a project, only globals.
    expect(db.listGroundPlane().map((e) => e.key)).toEqual(["a", "z"]);
  });

  test("provenance (source) is recorded", () => {
    db.setGroundPlane("k", "v", { source: "l3" });
    expect(db.listGroundPlane().find((e) => e.key === "k")!.source).toBe("l3");
  });

  test("missing key returns null", () => {
    expect(db.getGroundPlane("nope")).toBeNull();
  });
});

describe("CG2: buildGroundPlanePrompt (assembly)", () => {
  test("renders each entry as a section", () => {
    const text = buildGroundPlanePrompt([
      { project_id: "", key: "spec", value: "Build X", source: "l3", updated_at: "t" },
      { project_id: "", key: "test-cmd", value: "bun test", source: "l3", updated_at: "t" },
    ]);
    expect(text).toContain("## Ground plane");
    expect(text).toContain("### spec");
    expect(text).toContain("Build X");
    expect(text).toContain("### test-cmd");
    expect(text).toContain("bun test");
  });

  test("empty ground plane renders nothing", () => {
    expect(buildGroundPlanePrompt([])).toBe("");
  });
});

describe("CG2: set_ground_plane tool", () => {
  test("writes to the store with provenance", () => {
    const tool = createGroundPlaneTool(db, { projectId: "p", source: "l3" });
    const res = tool.execute({ key: "spec", value: "hello" }, {} as any);
    expect((res as any).isError).toBeFalsy();
    expect(db.getGroundPlane("spec", "p")).toBe("hello");
    expect(db.listGroundPlane("p").find((e) => e.key === "spec")!.source).toBe("l3");
  });

  test("rejects a missing key and a non-string value", () => {
    const tool = createGroundPlaneTool(db);
    expect((tool.execute({ key: "", value: "x" }, {} as any) as any).isError).toBe(true);
    expect((tool.execute({ key: "k", value: 5 as any }, {} as any) as any).isError).toBe(true);
  });

  test("rejects an over-cap value (legibility)", () => {
    const tool = createGroundPlaneTool(db);
    const big = "x".repeat(MAX_GROUND_PLANE_VALUE_CHARS + 1);
    const res = tool.execute({ key: "k", value: big }, {} as any);
    expect((res as any).isError).toBe(true);
    expect(db.getGroundPlane("k")).toBeNull(); // not written
  });

  test("the L3 turn can write the ground plane end-to-end", async () => {
    const result = await runL3Turn({
      db,
      message: "Record the spec.",
      cwd: tmpDir,
      model: "fake/model",
      registry: registryFor(groundPlaneWriter("spec", "Build a todo API")),
      projectId: "proj-1",
    });
    expect(result.isError).toBe(false);
    expect(db.getGroundPlane("spec", "proj-1")).toBe("Build a todo API");
  });
});

describe("CG2: executor injects the ground plane at run time", () => {
  test("an agent action's RunOptions carries the effective ground plane", async () => {
    db.insertProject(createProject({ id: "proj-1", project_dir: tmpDir }));
    db.setGroundPlane("spec", "Build a todo API"); // global
    db.setGroundPlane("test-cmd", "npm test", { projectId: "proj-1" }); // scoped

    db.insertAction(
      createAction({ id: "a", status: "pending", type: "agent", project_id: "proj-1", params: { prompt: "go" } }),
    );

    let captured: import("./action-runner").RunOptions | null = null;
    const spy: RunActionFn = async (_action, _preds, opts) => {
      captured = opts;
      return { condition: "pass", output: { status: "passed", summary: "ok" }, cost_usd: 0, duration_ms: 1, num_turns: 1 };
    };

    const exec = new Executor(db, { projectDir: tmpDir, runActionFn: spy });
    await exec.run();

    expect(captured).not.toBeNull();
    const gp = captured!.groundPlane ?? [];
    const keys = gp.map((e) => e.key).sort();
    expect(keys).toEqual(["spec", "test-cmd"]);
    // The assembled prompt would include it.
    expect(buildGroundPlanePrompt(gp)).toContain("Build a todo API");
  });
});
