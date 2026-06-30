---
id: vision-cloud-native-execution
type: vision
status: proposed
updated: 2026-06-30
applies_to: [executor, agent-runtime, actions, governance]
related: [vision-features, vision-thesis, principle-gate-before-reifying, open-question-definition-of-done-daemon]
---

# Cloud-native execution: where a task runs is a decision

Orca is local- and cloud-native: the **execution location** of an action is itself a
choice the orchestrator makes, not a fixed assumption that everything runs on the
user's machine.

Given credentials — an API key plus access to a provisioning CLI (e.g. DigitalOcean
`doctl`) — Orca can **determine, or ask, the best place to run a task**:

- a quick edit or short command runs **locally**;
- a long-running or detached job — a multi-hour build, a scraper, a load test — runs
  on a **cloud VPS** (or container) so it survives, doesn't tie up the laptop, and
  gets the network / isolation / resources it needs.

Decision factors: task duration and longevity, resource needs, network and isolation
requirements, cost, and explicit user preference. When the choice is clear Orca
decides; when it's ambiguous it **asks** — the same decide-or-ask judgment as
[[principle-gate-before-reifying]], applied to *placement* instead of reification.
This is the concrete form of "opinionated default tool choices and
environment-dependent behavior" from [[vision-features]]: picking Docker, a tunnel
like ngrok, etc., per environment.

It compounds the daemon model ([[open-question-definition-of-done-daemon]]): work
already runs detached and resumable, so pushing it to a VPS is a natural extension of
walk-away autonomy — close the laptop and the scraper keeps running in the cloud.

## Open surface

- **Provisioning lifecycle** — spin-up / teardown of VPSes, and who owns their state.
- **Working-tree sync** — getting the repo (and results) to and from the remote.
- **Secrets on remote** — credential handling off the local machine.
- **Cost governance** — the global circuit-breaker must account for cloud spend, not
  just tokens.
- **Execution target on the node** — likely an action carries its placement, tying
  this to the circuit / scheduler track.
