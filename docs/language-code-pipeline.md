# The Language → Code Pipeline: Failure Modes & Mitigations

The fundamental operation: given a natural language description + a codebase, produce the exact diff that correctly implements the described behavior. This is a deterministic target reached through non-deterministic means. Every failure mode is a way the system deviates from the one correct answer.

---

## 1. Intent Interpretation

The agent misunderstands what the human wants.

| # | Failure Mode | Current Mitigation | Gap |
|---|---|---|---|
| 1.1 | **Ambiguous spec** — description is vague, agent fills in gaps differently than human intended | Task descriptions with develop_focus, understand_focus | Specs can never be complete; some ambiguity is inherent |
| 1.2 | **Implicit requirements** — human assumes things that aren't stated (naming conventions, error handling style, UX patterns) | prompts.context provides project-wide conventions | No way to know what the human considers "obvious" |
| 1.3 | **Scope creep** — agent implements more than asked, touching unrelated code | "Make minimal, focused changes" in develop prompt | Agent may still over-engineer or add unwanted features |
| 1.4 | **Scope underreach** — agent implements less than asked, declares victory early | "What done means" section in develop prompt; QA gate | Ghost_text showed this: tests passed but rendering missing |
| 1.5 | **Wrong priority** — agent focuses on edge cases instead of the core feature | develop_focus variable to steer priority | Agent may still rabbit-hole on secondary concerns |
| 1.6 | **Misinterpreting existing behavior** — agent changes behavior that should be preserved | understand stage researches existing code | Agent may not trace all callers/dependents |
| 1.7 | **Lost in translation** — structured output schema constrains the agent's ability to express what it actually found/did | Schemas designed with open fields (summary, details) | Schema may force premature categorization |

## 2. Codebase Understanding

The agent doesn't know enough about the existing code to make correct changes.

| # | Failure Mode | Current Mitigation | Gap |
|---|---|---|---|
| 2.1 | **Can't find relevant code** — agent searches wrong files, misses the key module | understand stage with meta-one; Grep/Glob tools | Large codebases have non-obvious organization |
| 2.2 | **Stale mental model** — agent read code that was changed by a prior task/iteration | Session continuity preserves prior context | Session may remember outdated locations/patterns |
| 2.3 | **Missing cross-crate dependencies** — change in module A breaks module B that imports it | meta-one blast_radius | Not currently enforced, only suggested |
| 2.4 | **Misunderstanding patterns** — agent sees a pattern, applies it incorrectly | Context prompt explains project conventions | Implicit patterns aren't documented anywhere |
| 2.5 | **Context window limits** — agent can't hold the full relevant context at once | Session continuity, file-based message passing | Very large features may exceed context regardless |
| 2.6 | **Skimming instead of reading** — agent reads file headers but misses critical details deep in the file | No mitigation | Could use meta-one to extract specific functions |
| 2.7 | **Wrong abstraction layer** — agent understands the high-level but not the runtime behavior (async, threading, event ordering) | understand stage with targeted research focus | Complex runtime behavior is hard to infer from reading |

## 3. Design & Approach

The agent takes the wrong approach to solving the problem.

| # | Failure Mode | Current Mitigation | Gap |
|---|---|---|---|
| 3.1 | **Wrong architecture** — agent creates a new subsystem instead of extending existing one | understand stage; project context prompt | Agent may still choose a parallel approach |
| 3.2 | **Reinventing the wheel** — agent builds something that already exists in the codebase or dependencies | understand stage with meta-one | Agent may not search broadly enough |
| 3.3 | **Premature optimization** — agent over-engineers for hypothetical scale | "Make minimal, focused changes" prompt | Minimal guidance for architecture decisions |
| 3.4 | **Wrong abstraction** — agent creates helpers/traits that don't match the codebase's style | Project context prompt | Style matching is subjective |
| 3.5 | **Stub/mock escape** — agent satisfies tests without building real implementation | Anti-stub rules in write_tests, develop, analyze prompts; QA gate | Stubs that look real are hard to detect automatically |
| 3.6 | **Test-driven gaming** — agent optimizes for passing eval rather than correct behavior | QA stage verifies end-to-end behavior | QA itself may not catch all behavioral issues |
| 3.7 | **Circular fixes** — agent applies fix A, then fix B undoes A, then applies A again | Stuck detection (output hashing); session continuity | Stuck detection only catches identical outputs, not semantic loops |

## 4. Code Generation

The produced code is syntactically or semantically wrong.

| # | Failure Mode | Current Mitigation | Gap |
|---|---|---|---|
| 4.1 | **Syntax errors** — invalid code that doesn't parse | cargo check in develop workflow | Fast feedback via type-checking |
| 4.2 | **Type errors** — code doesn't satisfy the type system | cargo check | Rust catches most at compile time |
| 4.3 | **Borrow checker violations** — lifetime/ownership issues | cargo check | Agent may not understand why the borrow checker rejects code |
| 4.4 | **Logic errors** — code compiles but does the wrong thing | eval (tests); QA | Tests may not cover the specific logic path |
| 4.5 | **Off-by-one / boundary errors** — incorrect range handling | Tests with edge cases | Depends on test quality |
| 4.6 | **Error handling gaps** — missing Result handling, unwrap on None | cargo check catches some; tests may catch at runtime | Silent failures (returning Ok with wrong data) are invisible |
| 4.7 | **Race conditions** — async/threading bugs that only manifest intermittently | QA with repeated testing | Race conditions are nearly impossible to catch deterministically |
| 4.8 | **Memory/resource leaks** — file handles, sockets, watchers not cleaned up | No mitigation | Would need long-running QA or valgrind-style tools |
| 4.9 | **Hardcoded values** — magic numbers, hardcoded paths, platform assumptions | "Do NOT hardcode values" in develop prompt | Agent may still embed assumptions |
| 4.10 | **Copy-paste errors** — agent copies from one site and forgets to update variable names | No mitigation | Common with repetitive code |

## 5. Integration

Code doesn't fit the existing codebase correctly.

| # | Failure Mode | Current Mitigation | Gap |
|---|---|---|---|
| 5.1 | **Missing module registration** — new module exists but isn't declared in mod.rs/lib.rs | cargo check catches this | N/A — compiler enforced |
| 5.2 | **Missing feature flag guards** — code exists in all builds when it should be dev-only | No mitigation | Would need a feature-flag lint |
| 5.3 | **Dependency version conflicts** — new crate dependency conflicts with existing | cargo check | Agent may not know which versions are compatible |
| 5.4 | **Breaking API changes** — agent changes a pub function signature, breaking callers | meta-one blast_radius (suggested, not enforced) | No automated blast radius check before commit |
| 5.5 | **Config schema breakage** — new config field isn't backward-compatible | No mitigation | Would need config validation tests |
| 5.6 | **Missing keybind registration** — feature exists but the keybind to trigger it was never added | QA verifies end-to-end | QA may not test the specific trigger path |
| 5.7 | **Wrong event wiring** — handler exists but isn't connected to the event loop | QA verifies end-to-end | Tests may mock the event dispatch |

## 6. Behavioral / UX

Code runs but the user experience is wrong.

| # | Failure Mode | Current Mitigation | Gap |
|---|---|---|---|
| 6.1 | **Feature doesn't activate** — code exists but the trigger path is never reached | QA stage tests in running app | QA agent may not know how to trigger every feature |
| 6.2 | **Wrong visual rendering** — feature works internally but looks wrong on screen | QA checks via dev socket state | Dev socket may not expose visual rendering details |
| 6.3 | **Performance regression** — feature works but makes the editor slow | No mitigation | Would need benchmark suite |
| 6.4 | **Interaction conflicts** — new keybind conflicts with existing one | No mitigation | Would need keybind conflict checker |
| 6.5 | **State corruption** — feature works once but leaves editor in bad state | QA edge case testing | Hard to test all state transitions |
| 6.6 | **Undo/redo breakage** — change works forward but undo doesn't restore correctly | Specific test for undo | Depends on test coverage |
| 6.7 | **Multi-file interaction** — feature works on one file but breaks with splits/multiple buffers | Limited QA testing | QA may not test multi-buffer scenarios |

## 7. Test Quality

The verification layer itself is flawed.

| # | Failure Mode | Current Mitigation | Gap |
|---|---|---|---|
| 7.1 | **Tests too lenient** — assertions don't check the right things | Anti-stub rules; QA as second gate | Test quality depends on write_tests agent |
| 7.2 | **Tests self-contained with stubs** — tests define their own types instead of importing real ones | Explicit anti-stub rules in prompts | Prompt-based, not mechanically enforced |
| 7.3 | **Tests check implementation not behavior** — tests break on valid refactors | No mitigation | Would need test design guidelines per-project |
| 7.4 | **Missing negative tests** — tests check happy path only | "Include at least one negative test" in write_tests | One negative test is minimal coverage |
| 7.5 | **Test ordering dependency** — tests pass in one order but fail in another | "Each test should be independent" in write_tests | No enforcement via test shuffling |
| 7.6 | **Flaky tests** — tests pass/fail non-deterministically due to timing | No mitigation | Major issue for auto-reload, file watcher tests |
| 7.7 | **QA can't test the feature** — QA agent doesn't know how to exercise the feature (no socket, no CLI interface) | Dev socket for henry; project-specific QA instructions | Not all features are QA-testable this way |
| 7.8 | **QA too lenient** — QA passes features that don't actually work because it can't observe the behavior | Structured pass/fail output | QA agent may claim "passed" without thorough testing |

## 8. Pipeline / Infrastructure

The orchestration itself fails.

| # | Failure Mode | Current Mitigation | Gap |
|---|---|---|---|
| 8.1 | **Claude Code process crash** — SDK subprocess exits with code 1 | Retry with 1 retry; error notification; crash isolation | Root cause varies: API errors, billing, empty prompts |
| 8.2 | **Empty prompt** — template variable resolution produces empty string | Empty prompt guard in invokeWithRetry | Only catches fully empty; near-empty may still cause issues |
| 8.3 | **Billing/quota exhaustion** — API credits or subscription limit hit mid-build | Error surfaces in build log | No automatic pause-and-resume on billing errors |
| 8.4 | **Detached process dies silently** — orca process crashes, state says "running" forever | PID file check; crash detection in status/monitor | Depends on PID file existing |
| 8.5 | **File-based message passing race** — stage reads file while another writes | Stages run sequentially within a task | Not an issue currently due to sequential execution |
| 8.6 | **Session continuity backfires** — agent remembers stale context and repeats wrong actions | clear_session supervisor action | Supervisor may not recognize session staleness |
| 8.7 | **Compilation timeout** — cargo test takes longer than eval timeout (300s) | Configurable timeout | May need per-project tuning |
| 8.8 | **Disk space exhaustion** — JSONL logs, git snapshots, .orca data accumulate | No mitigation | Would need cleanup/rotation policy |
| 8.9 | **Port conflicts** — monitor port 7070 in use | Error message | No automatic port selection |
| 8.10 | **Binary mismatch** — orca-stable is out of date with config schema changes | Manual cp to orca-stable | No version tracking |
| 8.11 | **Notification failure** — ntfy/webhook silently fails | Errors swallowed in try/catch | No notification delivery confirmation |
| 8.12 | **Git state corruption** — snapshot/revert during an active stage leaves repo in bad state | Snapshot before develop | No lock to prevent concurrent git operations |
| 8.13 | **Max turns exhaustion** — agent runs out of turns mid-implementation | Configurable max_turns per stage | Agent may not prioritize; wastes turns on research instead of coding |
| 8.14 | **Toolset bypass** — bypassPermissions mode ignores allowedTools restriction | Known issue; currently accepted | Would need SDK-level enforcement |
| 8.15 | **QA feedback loop** — QA fails, develop doesn't fix the right thing, QA fails again indefinitely | Iteration budget (max_iterations) | Burns budget without progress (ghost_text spent $16) |

## 9. Information Flow

Data doesn't get where it needs to be.

| # | Failure Mode | Current Mitigation | Gap |
|---|---|---|---|
| 9.1 | **Stage output not read** — next stage ignores the output file | Prompts reference specific file paths | Agent may skip reading if it thinks it already knows |
| 9.2 | **QA feedback not reaching develop** — develop doesn't read qa.json | qa.json referenced in develop prompt (just fixed) | Was missing until this session |
| 9.3 | **Eval output not useful** — compile error output is too long/noisy to parse | Output truncation (last 5000 chars in cargo parser) | Truncation may cut off the relevant error |
| 9.4 | **Understand research lost** — understand produces great analysis but develop doesn't use it | File-based passing via understand.json | Agent may not read it on iteration 2+ |
| 9.5 | **Cross-task context lost** — task B could benefit from what task A learned | No cross-task information sharing | Each task has its own data directory |
| 9.6 | **Prompt too long** — project context + built-in prompt + stage injection + rendered variables exceeds useful length | No length checking | Could cause truncation or degraded attention |

## 10. Cost & Efficiency

The system wastes resources without making progress.

| # | Failure Mode | Current Mitigation | Gap |
|---|---|---|---|
| 10.1 | **Redundant compilation** — same code compiled multiple times in one iteration | Develop uses cargo check; eval is single cargo test | Already optimized in current workflow |
| 10.2 | **Idle loops** — develop returns "completed" without changes, eval passes, QA fails, repeat | QA failure detection; develop reads qa.json | ghost_text showed 13 idle cycles before fix |
| 10.3 | **Overspending on research** — understand stage uses 60 turns reading everything | Max turns limit | Agent may hit the limit before producing useful output |
| 10.4 | **QA too expensive** — QA runs full build + interactive test every iteration | No QA caching | Could skip QA if develop made no changes |
| 10.5 | **Session bloat** — resumed session accumulates megabytes of context over iterations | clear_session on escalation | No automatic detection of session bloat |
| 10.6 | **Full test suite in develop** — agent runs cargo test instead of cargo check | Prompt instructions to use cargo check | Prompt-based, not enforced; agent may ignore |

---

## Summary

The failure modes cluster into three meta-categories:

1. **The agent produces the wrong thing** (intent, design, code quality) — mitigated by multi-stage verification (type-check → test → QA)
2. **The verification doesn't catch the problem** (test quality, QA limitations) — mitigated by layered gates, but fundamentally limited by what can be observed
3. **The pipeline wastes resources** (idle loops, redundant work, information not flowing) — mitigated by workflow design, but requires ongoing tuning

The irreducible gap: natural language is ambiguous, implementation is concrete. The pipeline converts one to the other through progressive refinement (understand → write_tests → develop → eval → QA), but each stage introduces its own failure modes. The goal is not to eliminate non-determinism but to bound it — make the space of possible outputs small enough that the correct answer is the most likely one.
