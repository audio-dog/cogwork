# Test value

Use this reference when you add, change, review, or delete a test. It covers what a test must guard to
earn its place. `effect-test-layers.md` covers how an Effect test is structured; the Testing
heuristics in `docs/agents/technical-disposition.md` hold the reasoning behind both.

## The bar

A test earns its maintenance cost when it guards behavior a caller can observe, and a credible
regression turns it red. Before you add a test, or argue to keep one, answer four questions:

1. **What does it guard?** Name the observable behavior, invariant, or contract in the words of the
   package's `CONTEXT.md`.
2. **What turns it red?** Name the smallest credible production change that breaks that behavior. No
   such change means the test guards nothing.
3. **Why is it the only guard?** Each contract has one owning test at the strongest seam. A second
   test at another seam needs a risk the owner cannot reach: a transport failure, a restart, a race.
   A new case of an already-tested contract joins that test's table, and its duplicated setup moves
   into the shared test layer in the same change.
4. **Which production caller uses the seam it tests?** A seam only tests use means the test belongs
   at the real seam. See "Do not leak test needs into production interfaces" in
   `effect-test-layers.md`.

A test that goes red on a behavior-preserving refactor asserts the implementation; rewrite it at the
seam before it lands.

A bug-fix test goes red on the pre-fix code, for the bug's reason. After `Effect.flip`, assert the
failure's `_tag` or `reason`, so a rejection from a different guard cannot make it pass.

## Hunt list

The shapes that fail the bar. The authoring gate rejects a new test that matches one; an audit hunts
existing tests for them. A match makes a test a suspect, not a verdict: the retention bar below can
still keep it.

- **Tautology**: the expected value comes from the code under test, or is computed the way that code
  computes it. Expected values come from a literal, a worked example, or the spec.
- **The double does the work**: a stub layer implements the behavior the test asserts, so the
  assertion reads back what the stub produced. A probe records what the code under test did; the
  outcome the test checks comes from production code.
- **Declared, not exercised**: the test asserts that a Schema accepts its own literal, a table holds
  its entries, or a flag is set, where the path the declaration drives goes unrun. (Technical
  disposition: _declared is not reachable_.)
- **Duplicate guard**: one contract asserted at two seams with no separate risk, or near-identical
  tests that differ only in input.
- **Test-only seam**: an export, option, or service method that only tests call, or production code
  whose only callers are tests.
- **Assertion-free**: the test runs code and asserts nothing, or asserts only that a call which cannot
  fail did not fail.
- **Wrong-reason negative**: an expected failure passes because a different guard rejected the input;
  the failure's reason goes unasserted.
- **Oversold name**: the name or fixture promises more than the body exercises.
- **Implementation-coupled**: the test asserts a private helper, an internal call order no caller
  observes, or rendered structure in place of what a user sees and can do.

## Retention bar

Keep a test that is the only guard of:

- a wire contract in `packages/contracts`, the shapes the daemon and the desktop share;
- Control store convergence (ADR 0015), or other storage and migration behavior;
- an ADR-backed invariant: once-per-generation scheduling (engine ADR 0001), claiming, recovery,
  idempotency, ownership gates;
- a trust boundary: sandbox paths, credentials, what the engine withholds from a Run;
- a lint rule's block, in the `configs/lint` fixtures;
- call order, where a caller can observe the order.

For everything else, apply _test what fails silently_: **if this broke, would anything tell us?** When
the answer is "the next run just does the wrong thing", keep the test.

Slow is not a reason to delete. Suite cost goes through the sensor and the measured prototype in
ADR 0026. A test that resembles the implementation can still be the only guard of a contract: prove
it is not before you remove it.

## Sources

- `docs/agents/technical-disposition.md`, Testing and Evidence: _test through the interface_, _test
  what fails silently_, _declared is not reachable_.
- `docs/agent-patterns/effect-test-layers.md`: probe services and test-only interface leaks.
- `docs/adr/0026-test-suite-cost-is-a-per-test-budget-measured-by-seed-runs.md`: cut by measurement
  and judgment, never by category.
- OpenClaw's `test-audit` skill (`.agents/skills/test-audit/SKILL.md` in `openclaw/openclaw`): the
  four questions, the hunt list, and the retention bar are adapted from it. A **borrow**.
