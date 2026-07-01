---
id: vision-cloud-native-execution
type: vision
status: proposed
updated: 2026-07-01
applies_to: [executor, agent-runtime, actions, governance, serve-api]
related: [vision-context-as-graph, vision-thesis, vision-control-hierarchy, principle-unify-primary-and-supervisor, principle-legible-circuits-not-programs, principle-gate-before-reifying, open-question-definition-of-done-daemon, vision-features]
---

# Cloud-native execution: a federation of peer orcas

Orca is inherently distributed. An orca instance is not "the app" — it is a **node
in a mesh**. Each instance is a *full* orca: its own graph, executor, L3, supervisor,
and braid, exposed over the `orca serve` API. A laptop-only setup is just a mesh of
size 1; scaling out is adding peers. Where a task runs is which peer's graph it lives
in.

## Why peers (three models, one winner)

- **A — one graph on the laptop, remote is a dumb executor.** Killed by autonomy: close
  the laptop and the work stops.
- **B — one graph on an always-on VPS (single master), laptop = cached view.** Works,
  but demotes the laptop to a thin client, makes local-file work awkward, and a single
  master is a coordination bottleneck with a messy reconcile-on-reattach. **Rejected.**
- **C — peers, each owning its own graph, mutating each other's.** The most uniform, and
  it is *already what we do by hand*: the droplet runs an orca with its own graph, and
  the laptop drives it over HTTP (`/chat` seeds intent, `/actions` observes). Automating
  the laptop side **is** the peer model.

Model C reuses the primitive [[vision-context-as-graph]] already established — "planners
act by mutating the graph" — extended one hop: **a planner mutates another instance's
graph.** Same `apply_graph_edits`, across an instance boundary. `orca serve` already
exposes the graph as a mutation API + an SSE braid stream, so "local modifies remote
graph" is just **the local orca becoming a client of the API the remote already serves.**

## The move that makes it sane: single-writer-per-graph

Each orca **owns and serializes its own graph** through its own DRC chokepoint
(`applyValidatedDelta`). Peers do not write your graph directly — they *submit* validated
mutations, which you apply serially alongside your own. Exactly one serializer per graph.
No distributed locks, no CRDTs on the core write path; the governance chokepoint you
already have simply accepts mutations from an authenticated peer too.

**No cross-graph edges — ever.** An edge never spans instances. A remote build is a
*self-contained subgraph* in the remote graph; the local holds a **handle**, never a live
edge. This is the invariant that keeps a dying peer from corrupting anyone else's graph.

## Staleness is not a correctness problem

Correctness comes from **validate-at-apply under single-writer serialization**, not from
the freshness of a read. The remote applies each edit against its *current* state
atomically. So a local peer **fetches the remote graph to plan**, then submits — and a
stale read can only ever cost a **rejected edit + retry**, never a corrupt graph:

- **Additive, self-contained submits** (a new goal / build subgraph) — staleness is
  irrelevant; the edit doesn't depend on precise current state.
- **Edits referencing existing nodes** — if a node changed incompatibly in the window,
  the chokepoint *rejects* (dangling ref, cycle, CG4 freeze-on-run); refetch and retry.

The only residue — two peers editing the **same node's same field** — is eliminated by
**region-ownership** (the local owns intent/goal nodes; the remote owns the elaboration
beneath them), with **idempotent submits** (client-supplied ids) so retries are no-ops and
a **compare-and-swap precondition** for the rare genuine shared write. Net: fetch-to-plan
→ additive, idempotent edit → validate-at-apply serializes it → region-ownership means no
shared writes → CAS for the exception. No logical clocks, no merge engine.

## Local seeds intent, the remote's own L3 elaborates

The remote is neither a dumb executor nor a slave to a master. The **local L3 submits
high-level intent** (a goal node + a message) into the remote graph; the **remote's own
L3 recons and decomposes it** — lazy expansion, but the expander lives on the remote. That
is what makes the remote genuinely autonomous: its L3 + supervisor recover failures and
replan **while the laptop is closed**. Region-ownership keeps the two planners from
colliding. This is [[vision-context-as-graph]] applied *across instances*.

## Autonomy, and the reconnect that isn't a reconcile

Close the laptop and the remote peer keeps running its own graph. Reattach and the local
just **re-subscribes** to the remote braid and catches up — **no master reconciliation**,
because the remote graph was always authoritative for remote work; the laptop never owned
it. Model B's split-brain problem simply does not exist here. This is the async braid of
the TUI spec stretched to a timescale of hours; a "since you were gone" digest is a braid
query.

## Roles, not tiers

Laptop, always-on **orchestrator** VPS, and ephemeral **worker** boxes are all the *same
software* (full orcas), differentiated by **role and lifecycle**, not kind. Peers spawn
peers: the orchestrator provisions workers and submits builds to them; the laptop
provisions the orchestrator and submits intent. Fractal and uniform from 1 node to N. The
cost math falls out: a *tiny always-on brain* (orchestrator) plus *elastic muscle*
(workers spun up and torn down) — you never pay for a big box 24/7.

## Placement is a decision; the constitution carries the policy

Which peer's graph a task goes in is a placement decision — heavy / long / **untrusted
(code-generating)** work to a disposable worker (isolation + disposability, not just
horsepower); quick / local-file / trusted work stays local. When clear, orca decides; when
ambiguous, it **asks** — [[principle-gate-before-reifying]] applied to placement.

The policy itself is a **built-in behavioral module** — orca's *constitution*, the top,
orca-authored layer of the same context assembly as [[vision-context-as-graph]] (below
project ground-plane and per-task prompt). It is **conditionally active** — dormant on a
laptop with no substrate configured, live when a provider is reachable — and it rides on a
**substrate grounding** injected the way `workspaceGrounding` is: "here is your execution
topology, which peers are up, and whether the user is attached," so the planner *recons its
infrastructure* before placing work.

## Open surface

- **Optimistic-concurrency protocol — design first.** Fetch-to-plan + validate-at-apply +
  region-ownership + idempotent ids + CAS. The convention gates safe cross-peer planning.
- **Identity, auth, capability.** Cross-peer mutation must be authenticated and
  capability-gated; a secure channel and peer discovery.
- **Merged-braid ordering.** The unified UI merges N peers' braids with no global clock →
  logical/causal clocks for a coherent interleaving.
- **Lifecycle is a tree.** Symmetric graphs, asymmetric provenance (local → orchestrator →
  workers). Orphan/GC when a parent dies; teardown to control cost.
- **Cost governance.** The global circuit-breaker must account for cloud spend and per-peer
  provisioning, not just tokens.
- **Secrets & sync.** Code crosses via git; secrets stay on the trusted peer and are never
  shipped to a disposable worker; artifacts flow back over the mutation/observation channel.
- **What a worker runs.** Full L3 (autonomous recovery) vs. execute-only — leaning full,
  bounded by region-ownership.

## What this settles

- **[[open-question-definition-of-done-daemon]]** — the close-laptop requirement *forces*
  the daemon: an orca instance is a persistent, always-on peer, not a script tied to a
  session.
- **State locality** — answered by *distributed ownership*: work lives in the graph of the
  peer that runs it, not in one master. That matches how the work is physically distributed.
