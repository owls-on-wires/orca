// fixture.jsx — Orca DAG demo fixture.
//
// Topology mirrors the canonical 12-node fan-out / mid-convergence / fan-in
// example. Three branches from a single source, four spanning edges of
// varying length, a mid-graph convergence at M, and a final fan-in at End.
//
//   col:   0      1       2       3       4       5
//   row 1                A1 ─── A2 ─── A3 ─────────────┐
//   row 2  Start ─┐                     M ──────────── End
//   row 3        B1 ─── B2 ──────────────────────────┘
//   row 4        C1 ─── C2 ─── C3 ─── C4 ────────────┘
//                  (B1 also spans up to M; A2 also spans down to M)
//
// Critical path: Start → C1 → C2 → C3 → C4 → End  (length 5)

const ORCA_FIXTURE = (() => {
  const tasks = [
    { id: "release", label: "release", color: "teal" },
  ];

  const mk = (id, label, type, status, extra = {}) => ({
    id, task: "release", label, type, status, x: 0, y: 0, ...extra,
  });

  // Row hints follow the canonical 4-row layout from the spec:
  //   row 0  A-chain  (A1, A2, A3)
  //   row 1  Start, M, End  (median: source, mid-convergence, sink)
  //   row 2  B-chain  (B1, B2)
  //   row 3  C-chain  (C1, C2, C3, C4) — longest chain on its own row
  const ROW = { A: 0, MEDIAN: 1, B: 2, C: 3 };

  const actions = [
    // col 0
    mk("start", "plan", "agent", "completed", {
      row: ROW.MEDIAN,
      iter: 1, cost: 0.32, turns: 8,
      summary: "Cut release plan: scope, batches, smoke matrix.",
      params: { prompt: "Plan release v1.5.0.", max_turns: 20 },
    }),

    // col 1 — three branches
    mk("A1", "changelog",  "agent",   "completed", {
      row: ROW.A,
      iter: 1, cost: 0.41, turns: 12,
      summary: "Generated CHANGELOG.md from commit log between v1.4 and HEAD.",
      params: { prompt: "Write user-facing changelog from git log v1.4.0..HEAD.", max_turns: 30 },
    }),
    mk("B1", "scaffold",   "command", "completed", {
      row: ROW.B,
      iter: 1, cost: 0.00, turns: 0,
      summary: "Scaffolded release branch · cut release/v1.5.0 from main.",
      params: { cmd: "git checkout -b release/v1.5.0" },
    }),
    mk("C1", "build",      "command", "completed", {
      row: ROW.C,
      iter: 1, cost: 0.00, turns: 0,
      summary: "Build green · 38 artifacts · 2.1MB total.",
      params: { cmd: "pnpm build --release" },
    }),

    // col 2
    mk("A2", "draft·notes", "agent",  "completed", {
      row: ROW.A,
      iter: 1, cost: 0.28, turns: 9,
      summary: "Wrote launch-day blog post draft and customer email.",
      params: { prompt: "Draft public release notes (blog + email).", max_turns: 25 },
    }),
    mk("B2", "version·bump", "command", "completed", {
      row: ROW.B,
      iter: 1, cost: 0.00, turns: 0,
      summary: "Bumped package.json + lockfile · v1.4.0 → v1.5.0.",
      params: { cmd: "pnpm version minor && pnpm install" },
    }),
    mk("C2", "eval",        "agent",   "failed", {
      row: ROW.C,
      iter: 1, cost: 0.38, turns: 12,
      summary: "Bundle exceeded size budget by 18kb in vendor.js.",
      notes: "Tree-shaking missed three lodash chunks. Recommend retry with import-pruning toolset.",
      params: { prompt: "Evaluate the build against perf + size budgets.", max_turns: 20 },
    }),

    // col 3
    mk("A3", "review·notes", "agent",  "completed", {
      row: ROW.A,
      iter: 1, cost: 0.16, turns: 5,
      summary: "Editor pass on launch copy; tone aligned with brand voice guide.",
      params: { prompt: "Edit launch copy for clarity and tone.", max_turns: 15 },
    }),
    mk("M",  "compose·release", "agent", "running", {
      row: ROW.MEDIAN,
      iter: 1, cost: 0.22, turns: 7,
      summary: "Stitching changelog + branch metadata into a release manifest.",
      params: { prompt: "Compose release manifest from changelog + branch state.", max_turns: 30 },
    }),
    mk("C3", "supervisor",  "agent",   "completed", {
      row: ROW.C,
      iter: 1, cost: 0.21, turns: 6,
      summary: "Detected size-budget fail; bumped develop max_turns 60→80; rerouted to develop·r2.",
      params: { prompt: "Decide escalation strategy.", max_turns: 10 },
    }),

    // col 4
    mk("C4", "develop·r2",  "agent",   "running", {
      row: ROW.C,
      iter: 2, cost: 0.74, turns: 18,
      summary: "Rebuilding with import-pruning; vendor.js trimmed 22kb so far.",
      params: { prompt: "Re-evaluate after pruning.", max_turns: 80 },
    }),

    // col 5 — sink
    mk("end", "publish",    "command", "pending", {
      row: ROW.MEDIAN,
      summary: "—",
    }),
  ];

  const edges = [
    // Start fans out to three branches
    { from: "start", to: "A1", cond: "pass" },
    { from: "start", to: "B1", cond: "pass" },
    { from: "start", to: "C1", cond: "pass" },

    // A chain (top row)
    { from: "A1", to: "A2", cond: "pass" },
    { from: "A2", to: "A3", cond: "pass" },

    // B chain (lower-mid row)
    { from: "B1", to: "B2", cond: "pass" },

    // C chain (bottom row, longest)
    { from: "C1", to: "C2", cond: "pass" },
    { from: "C2", to: "C3", cond: "fail" },          // size-budget fail
    { from: "C3", to: "C4", cond: "retry" },         // supervisor reroutes

    // Mid-graph convergence at M
    { from: "A2", to: "M",  cond: "pass" },
    { from: "B1", to: "M",  cond: "pass" },          // spanning edge col 1→3

    // Final fan-in to End
    { from: "A3", to: "end", cond: "pass" },         // spanning col 3→5
    { from: "M",  to: "end", cond: "pass" },         // spanning col 3→5
    { from: "B2", to: "end", cond: "pass" },         // spanning col 2→5 (longest)
    { from: "C4", to: "end", cond: "pass" },

    // Dashed retry / fail loops (back-edges; do not affect ranking)
    { from: "C2", to: "C1",  cond: "fail",  dashed: true },
    { from: "C4", to: "C1",  cond: "fail",  dashed: true },
  ];

  return { tasks, actions, edges };
})();

window.ORCA_FIXTURE = ORCA_FIXTURE;
