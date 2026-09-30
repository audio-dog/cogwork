# Test value

The general bar lives in the shipped
[`TEST-VALUE.md`](../../packages/engine/operating-instructions/implement-agent/TEST-VALUE.md). Read it
first when you add, change, review, or delete a test. This reference adds cogwork's retention bar and
Effect-specific shapes. `effect-test-layers.md` covers how an Effect test is structured; the Testing
heuristics in `docs/agents/technical-disposition.md` hold the reasoning behind both.
`/test-audit` reads the shipped file and this reference before it sweeps a scope.

## Effect shapes

- After `Effect.flip`, assert the expected failure's `_tag` or `reason`, so a rejection from a
  different guard cannot make a negative test pass.
- A stub Layer supplies dependencies. A probe records what production code did. When a stub Layer
  implements the outcome under assertion, the double does the work and the test guards the stub.
- An export, option, or service method used only by tests is a test-only seam. Move the test to the
  production seam; see "Do not leak test needs into production interfaces" in
  `effect-test-layers.md`.

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
- `packages/engine/operating-instructions/implement-agent/TEST-VALUE.md`: the general test-value bar.
- `docs/agent-patterns/effect-test-layers.md`: probe services and test-only interface leaks.
- `docs/adr/0026-test-suite-cost-is-a-per-test-budget-measured-by-seed-runs.md`: cut by measurement
  and judgment, never by category.
- OpenClaw's `test-audit` skill (`.agents/skills/test-audit/SKILL.md` in `openclaw/openclaw`): the
  four questions, the hunt list, and the retention bar are adapted from it. A **borrow**.
