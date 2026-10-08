# 0031 — The test-value bar ships with the Operating Instructions, and every new test carries a red proof

- **Status:** proposed
- **Date:** 2026-09-30

## Context

Most tests in this repo are written by implement and follow-up Runs, with no human in the session.
The bar a test must meet to earn its place now exists as
[`docs/agent-patterns/test-value.md`](../agent-patterns/test-value.md), reached by one pointer line
in `AGENTS.md`. That pointer does not reach the Runs that write the tests, for three reasons:

- **It is ambient.** `AGENTS.md` is a lower instruction layer than the Operating Instructions (engine
  ADR [0007](../../packages/engine/docs/adr/0007-context-assembler-layers-and-playbook-skill-provision.md)),
  and a pointer is a reference a Run may never follow. _Explicit over ambient_: anything mandatory
  arrives because the engine supplied it.
- **It reaches one Workspace.** The doc lives in this repo. A Run in any other registered Workspace
  never sees it, although the shipped `implement-agent` package writes that Workspace's tests too.
- **Nothing checks it.** The implement gate proves that tests pass. It never asks whether a new test
  can fail, so a test that guards nothing passes the gate by construction.

A test that guards nothing is expensive to remove later. ADR
[0026](./0026-test-suite-cost-is-a-per-test-budget-measured-by-seed-runs.md) rejects deleting tests by
category, so removal takes a per-test audit with evidence — the `/test-audit` skill. Prevention at
write time is the cheap end of that cost.

OpenClaw's recent history shows the other end. Its maintainers opened 99 "remove low-value tests"
pull requests in two weeks against a target of 100,000 net lines
([openclaw#139428](https://github.com/openclaw/openclaw/issues/139428)). They added an authoring gate
to their `test-audit` skill because, in their words, "agents keep adding tests that restate
implementation or repeat the same contract across layers"
([openclaw#156316](https://github.com/openclaw/openclaw/pull/156316)). Their gate is a skill the model
may invoke: advisory, with no proof the gate can check. Their cleanup batches then needed coverage
bounds and two independent review rounds to catch the gaps the deletions opened. This decision
borrows the gate's content and adds the proof they lack. It is a **borrow**, one project's choice,
not a convergence.

Two things constrain the shape. Rules with globs such as `**/*.test.ts` would carry path-scoped
guidance, but the engine does not evaluate Rule globs yet. And
[#764](https://github.com/colonylabs/cogwork/pull/764) has rewritten both shipped packages to ADR
[0027](./0027-headless-review-is-one-bounded-round-of-report-only-reviewers.md)'s shape — the
"Write it lean" ladder, the Checks stage, and the three-review round — so this change lands on that
text.

## Decision

**The general test-value bar ships as one shared resource in the stock `implement-agent` and
`follow-up-agent` packages.** The four questions, the hunt list, and the bug-fix rule move from
`docs/agent-patterns/test-value.md` into one engine-owned `shared/test-value/TEST-VALUE.md`. The
context assembler copies that bundle into each stock Run package as `test-value/TEST-VALUE.md`.
Workspace overrides remain whole-package replacements and do not inherit the shared resource. The
"Implement" step names it beside `/tdd` and the lean-code ladder: simple tests are generated, not
retrofitted, the same argument ADR 0027 made for lean code. The repo doc keeps only what is this
repo's own — the retention bar that names cogwork's contracts and ADR-backed invariants, and the
Effect-specific shapes — and points at the shipped file for the rest.

**Every new or changed test carries a red proof, and the proof is a gate item.** The test must fail
on an assertion, from one of two sources:

- **Base**: run against the base commit's production code — for a bug fix or a behavior change. The
  gate's baseline-failure procedure already checks the base out in the same worktree.
- **Mutation**: run against a small, named break of the new production code — for new behavior,
  where the base has nothing to fail against.

An import, compile, or type error is not a red: it proves the symbol is new, not that the test
guards anything. One proof covers a contract, not every case in its table. A test that only moves,
or a characterization test that passes on the base by design, says so instead. The proof runs in the
Checks stage, before review, so reviewers can read it.

**The proof is recorded where a human reviews the change.** The implement package's PR body gains a
"Test proof" section; the follow-up package, which has no PR body, records the same entries in its
summary reply. Each entry names the test, the red source (base, or the mutation in one line), and
the failing assertion. This is the completion criterion the gate binds to, and what a reviewer
checks.

**The minimalist review receives `test-value/TEST-VALUE.md`.** The review stage's dispatch line hands the
minimalist the resource, so it judges added tests against the hunt list as needless code. The
minimalist's brief is an ambient subagent definition, so the resource travels in the dispatch, not
in the brief. No reviewer is added: ADR 0027's three-review bound holds.

## Considered Options

**The `AGENTS.md` pointer alone.** The status quo this decision replaces: ambient, one Workspace,
nothing checked.

**A Rule scoped to test globs.** The right carrier for path-scoped guidance, and the likely home for
this repo's own half once the engine evaluates Rule globs. Not available today, and a Rule is
advisory, so it could never carry the proof.

**A fourth, test-focused reviewer.** Breaks ADR 0027's bound, and catches the test after it is
written. The proof moves the check to write time, where it costs one test run.

**A GritQL rule for assertion-free tests.** More mechanism than the problem needs: the red proof
already fails a test with no assertion, because such a test cannot fail on one.

**A coverage-delta gate.** OpenClaw's cleanup batches hold statement and branch loss under 1%.
Coverage is a structural diagnostic, not a target (technical disposition): a test at full coverage
can guard nothing, and coverage cannot tell a sole guard from a duplicate.

**A mutation-testing tool in CI.** Mutates everything, not the contract a test names, and spends the
suite budget ADR 0026 caps at 30 ms per test. The named mutation buys the same evidence for the one
contract under change.

**The engine verifies the proof now.** The engine does not know a Workspace's test commands; the
Run discovers them. Deferred: the engine can first check that the "Test proof" section names every
test the diff adds, once real Runs show the section is reliable.

## Consequences

- Both shipped packages change: the "Implement" and "Fix" steps, the Checks stage, the implement PR
  body template and the follow-up summary, and the minimalist dispatch line. The context assembler
  adds the shared resource to stock packages before it reads their resources. Engine tests cover
  the composition and the shipped instruction text.
- `docs/agent-patterns/test-value.md` shrinks to this repo's retention bar and Effect shapes, and
  points at the shared `TEST-VALUE.md`. `/test-audit` reads both.
- The colony Workspace's private-overlay forks (ADR
  [0019](./0019-per-workspace-operating-instructions-overrides.md)) receive none of this until they
  are updated by hand, as for ADR 0027.
- Implement Runs spend more turns: one test run per new contract, plus a mutation and a restore
  where the base cannot serve. ADR 0027's bounded-review wall time is the baseline to measure the
  increase against.
- A test that cannot name its red lands with the gap written in its PR body, where a human reviewer
  sees it, rather than merging silent.
