---
name: test-audit
description: Sweep a scope of tests against the test-value bar, prove each suspect with a mutation, and publish disjoint cleanup tickets.
disable-model-invocation: true
---

# Test Audit

One session, one artifact: **tickets** that delete, merge, move, or rename the tests that fail the bar
in [`docs/agent-patterns/test-value.md`](../../../docs/agent-patterns/test-value.md). That doc is the
rulebook; this skill runs the sweep. The session commits nothing. Deleting a test loses signal for
good (ADR 0040), so each deletion reaches an agent only through a ticket that names it and carries
its proof, and the human approves the breakdown first.

Argument: the scope, a package, directory, or list of test files. No scope given: ask for one. A few
proven candidates beat a long list of suspects.

## Resolve the ground

Read `test-value.md`, `effect-test-layers.md`, the Testing heuristics in
`docs/agents/technical-disposition.md`, the scope's `GLOSSARY.md`, and the ADRs for the area. An ADR
that names an invariant puts the tests guarding it on the retention bar.

## Phase 1 — Discover

Fan out read-only background subagents, one per package or directory in scope. Each reads every test
file in its lane in full, beside the production module it exercises, and returns two lists:

- **Suspects**: test name, file:line, the hunt-list shape it matches, and the behavior its name claims.
- **Clean**: every other test file in the lane.

Done when every test file in scope sits in exactly one list.

## Phase 2 — Prove

The **mutation check** turns a suspect into a verdict. Run it in a separate git worktree
(`git worktree add`, then `pnpm setup-worktree` inside it). The human's running app reloads from the
main checkout, so a mutation there breaks their session. Run proofs one at a time, so each test run
reads exactly one mutation.

For each suspect:

1. Make the smallest production change that breaks the behavior the test names.
2. Run the package's tests: `pnpm --filter <package> test`.
3. Record every test that went red, then restore the file.

| Mutation result | Verdict |
| --- | --- |
| The suspect stays green | It guards nothing it names: **delete**, or **rename** it to what it does guard |
| The suspect goes red with others | Duplicate guard: keep the one at the strongest seam; **merge** or **delete** the rest |
| Only the suspect goes red | Sole guard: **keep**, or **move** it to the seam when its shape is on the hunt list |

Then fill the suspect's **evidence card**:

- test name and file:line;
- the mutation, and every test it turned red;
- the non-test callers of any seam the test keeps alive;
- why the test exists: `git log -S` or blame, and the issue or PR behind it;
- the verdict (**delete**, **merge** into a named test, **move** to a named seam, **rename**, or
  **keep** with the retention-bar line that keeps it);
- what else the verdict deletes: a test-only export, a helper, a dead production path.

Done when every suspect has a complete card and `git status` in the worktree is clean. A card with an
empty field becomes **keep, unproven**.

## Phase 3 — Cut and publish tickets

Partition every card whose verdict is not a keep into tickets:

- **Disjoint ownership**: two tickets that may run in parallel share no file. Each ticket body carries
  a "Scope (owned files)" section.
- **One seam per ticket**, so a reviewer reads each deletion beside its proof.
- Each ticket carries its evidence cards verbatim, file:line included. This overrides `/to-tickets`'
  rule against file paths: the card is the proof, and the implementer does not repeat it.
- Acceptance criteria: every card's verdict applied; each merged or moved test goes red on its card's
  mutation; the package's tests, typecheck, and `pnpm format-and-lint` pass; the PR body states the
  test-count delta.

Publish through `/to-tickets` and follow it, including its quiz step.

## Handoff

Report:

- the tickets, as links, with their blocking edges;
- the count of each verdict, **keep, unproven** included;
- every keep card that matched a hunt-list shape, with the line that keeps it, so the next audit skips
  these false positives;
- the clean list, so the next audit starts past it;
- the test-count delta the tickets cause.
