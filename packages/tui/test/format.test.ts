import { test, expect, describe } from "bun:test";
import { glyph, formatCost, formatElapsed, burnRate, treePrefix, rowLine } from "../src/format";
import type { CircuitRow } from "../src/types";

describe("format", () => {
  test("glyphs cover every status", () => {
    expect(glyph("pending")).toBe("○");
    expect(glyph("running")).toBe("◐");
    expect(glyph("completed")).toBe("✓");
    expect(glyph("failed")).toBe("✕");
    expect(glyph("stuck")).toBe("⚠");
    expect(glyph("waiting")).toBe("⏸");
  });

  test("cost is 2-dp dollars", () => {
    expect(formatCost(4.2)).toBe("$4.20");
    expect(formatCost(0)).toBe("$0.00");
  });

  test("elapsed is mm:ss and h:mm:ss past an hour", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(75_000)).toBe("01:15");
    expect(formatElapsed(3_675_000)).toBe("1:01:15");
  });

  test("burn rate is $/min, guarded at t=0", () => {
    expect(burnRate(1, 0)).toBe("$0.00/min");
    expect(burnRate(2, 60_000)).toBe("$2.00/min");
    expect(burnRate(1, 120_000)).toBe("$0.50/min");
  });

  test("tree prefix indents by depth", () => {
    expect(treePrefix(0)).toBe("");
    expect(treePrefix(1)).toBe("├─");
    expect(treePrefix(2)).toBe("│ ├─");
  });

  test("row line includes glyph, id, tool, cost", () => {
    const row: CircuitRow = {
      id: "task.build", type: "agent", status: "running",
      costUsd: 0.08, durationMs: 0, iteration: 2, currentTool: "Edit",
      successors: [], depth: 1,
    };
    const line = rowLine(row);
    expect(line).toContain("◐");
    expect(line).toContain("task.build");
    expect(line).toContain("×2");
    expect(line).toContain("$0.08");
    expect(line).toContain("Edit");
  });
});
