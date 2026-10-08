# Test value

A test earns its maintenance cost when it guards behavior a caller can observe, and a credible
regression turns it red. Before you add a test, or argue to keep one, answer four questions:

1. **What does it guard?** Name the observable behavior, invariant, or contract in the domain words
   of the package.
2. **What turns it red?** Name the smallest credible production change that breaks that behavior. No
   such change means the test guards nothing.
3. **Why is it the only guard?** Each contract has one owning test at the strongest seam. A second
   test at another seam needs a risk the owner cannot reach: a transport failure, a restart, a race.
   A new case of an already-tested contract joins that test's table, and its duplicated setup moves
   into shared test setup in the same change.
4. **Which production caller uses the seam it tests?** A seam only tests use means the test belongs
   at the real seam.

A test that goes red on a behavior-preserving refactor asserts the implementation. Rewrite it at the
seam before it lands.

A bug-fix test goes red on the pre-fix code, for the bug's reason. Assert the expected failure's
identity or reason, so a rejection from a different guard cannot make it pass.

## Hunt list

The shapes that fail the bar. A match makes a test a suspect, not an automatic verdict; a workspace
can have a local retention rule that keeps it.

- **Tautology**: the expected value comes from the code under test, or is computed the way that code
  computes it. Expected values come from a literal, a worked example, or the specification.
- **The double does the work**: a stub implements the behavior the test asserts, so the assertion
  reads back what the stub produced. A probe records what the code under test did; the outcome the
  test checks comes from production code.
- **Declared, not exercised**: the test asserts that a schema accepts its own literal, a table holds
  its entries, or a flag is set, while the path the declaration drives goes unrun.
- **Duplicate guard**: one contract is asserted at two seams with no separate risk, or near-identical
  tests differ only in input.
- **Test-only seam**: an export, option, or service method that only tests call, or production code
  whose only callers are tests.
- **Assertion-free**: the test runs code and asserts nothing, or asserts only that a call which cannot
  fail did not fail.
- **Wrong-reason negative**: an expected failure passes because a different guard rejected the input;
  the failure's identity or reason goes unasserted.
- **Oversold name**: the name or fixture promises more than the body exercises.
- **Implementation-coupled**: the test asserts a private helper, an internal call order no caller
  observes, or rendered structure in place of what a user sees and can do.
