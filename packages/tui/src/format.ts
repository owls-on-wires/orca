/**
 * Pure presentation helpers — glyphs, burn rate, elapsed, money. No Ink here so
 * they unit-test cleanly.
 */

import type { ActionStatus, CircuitRow } from "./types";

/** Circuit-row status glyphs (spec-tui). */
export function glyph(status: ActionStatus): string {
  switch (status) {
    case "pending": return "○";
    case "running": return "◐";
    case "completed": return "✓";
    case "failed": return "✕";
    case "waiting": return "⏸";
    case "stuck": return "⚠";
    case "skipped": return "⊘";
    case "inactive": return "·";
    default: return "?";
  }
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** mm:ss (or h:mm:ss past an hour) from a millisecond span. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** $/min burn rate given total spend and elapsed span. 0 before any time passes. */
export function burnRate(costUsd: number, elapsedMs: number): string {
  if (elapsedMs <= 0) return "$0.00/min";
  const perMin = costUsd / (elapsedMs / 60000);
  return `$${perMin.toFixed(2)}/min`;
}

/** Tree-connector prefix from topological depth (├─ style indentation). */
export function treePrefix(depth: number): string {
  if (depth <= 0) return "";
  return `${"│ ".repeat(Math.max(0, depth - 1))}├─`;
}

/** One compact circuit-row line: `glyph · id · state · dur · cost · tool`. */
export function rowLine(row: CircuitRow): string {
  const parts = [glyph(row.status), row.id, row.status];
  if (row.iteration > 0) parts.push(`×${row.iteration}`);
  if (row.costUsd > 0) parts.push(formatCost(row.costUsd));
  if (row.currentTool) parts.push(`⠿ ${row.currentTool}`);
  return `${treePrefix(row.depth)}${parts.join("  ")}`;
}
