---
id: principle-no-runtime-deps
type: principle
status: authoritative
updated: 2026-06-30
applies_to: [build, packaging, dependencies]
related: [decision-0001-reify-plan-as-durable-graph]
---

# No runtime dependencies

Orca ships as a single compiled TypeScript binary. No Python, no runtime
dependency on an interpreter, service, or external store beyond what is bundled.

**Why:** distribution and operational simplicity — `orca` is one artifact you drop
on a laptop, a VPS, or CI and run. It is also a forcing function: a feature that
would require heavy runtime infrastructure (a vector DB, a language server, a
daemon fleet) must be reworked to fit SQLite + the binary, or justified hard.

**How to apply:** prefer SQLite (already in the stack) and in-process logic over
new services. When a design reaches for Postgres / pgvector / Redis / a Python
sidecar, treat it as a smell and find the SQLite-native or in-binary equivalent
first.
