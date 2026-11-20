# 0040 — The test-suite cost sensor is removed

- **Status:** accepted
- **Date:** 2026-11-20
- **Supersedes:** ADR [0026](./0026-test-suite-cost-is-a-per-test-budget-measured-by-seed-runs.md)
- **Amends:** ADR [0022](./0022-a-sensor-lives-where-its-signal-is-produced.md),
  ADR [0023](./0023-performance-budgets-file-work-the-app-has-never-done.md)

## Context

ADR 0026 built a test-suite cost sensor, with parts from ADR 0022. It had these parts:

- a seed run on each push to `main` that measured the uncached suite;
- a budget of 30 ms per test, which a weekly check read from the seed-run history;
- a budget for the slowest test file;
- the paired comparison tool, for bisection;
- test count and timing reporters, and a "Test suite" summary table on each pull request.

ADR 0026's measurements and the runs of the weekly check give these facts:

- Inside one job, the measurement noise is about ±6%. Across jobs, a comparison is not reliable: the
  same commit measured 101 s and 156 s.
- Concurrency tuning had no measurable effect.
- The cost comes from starvation of real subprocesses on the 4-vCPU runner, not from the test bodies.
- The weekly budget check failed each week from October 5 to November 16 with
  `invalid seed-run history: Missing key`. It filed zero tickets, and nobody noticed.

The mechanism was too complex for the signal it gave. A sensor that fails silently is the type of
loss that ADR [0021](./0021-the-performance-sensor-files-its-own-tickets.md) exists to prevent.

## Decision

**The test-suite cost sensor is removed.** These parts are deleted: the seed-run measurement, the
per-test budget, the slowest-test-file budget, the paired comparison tool, the test count and timing
reporters, and the pull-request summary table. The Performance issue filer accepts only the
`health-signal` verdict kind. The `suite-comparison`, `budget`, and `test-file-budget` kinds are
deleted.

**The seed run becomes a cache warm-up.** It runs `turbo run test` on each push to `main` and saves
the turbo cache at the `main` scope. Pull-request runs restore that cache. It does not force task
execution, and it records no measurement.

**These rules stay in effect:**

- Slow is not a reason to delete a test.
- Suites are never cut by category.

**ADR 0023's "a budget is a count, never a duration" has no exception.** ADR 0026's carve-out for a
per-test duration budget is withdrawn.

These parts of ADR 0026 do not measure, and they stay:

- the lint-rule fixtures run the real linter in their own workflow, only when the lint config
  changes;
- the suites that do real subprocess work declare explicit timeouts;
- local Vitest concurrency is bounded by `localWorkerLimit`.

This ADR makes no recommendation for a later approach to test-suite cost.

## Considered Options

**Fix the seed-run history decode and keep the sensor.** Rejected. The fix makes the check run
again, but the mechanism stays too complex for the signal it gives.

**Keep the paired comparison tool for manual bisection.** Rejected. After the budgets are removed,
nothing calls it.

## Consequences

- ADR 0026 is superseded.
- ADR 0022: the scheduled test-suite comparison is not built, and the comparison tool is deleted.
  "A sensor lives where its signal is produced" stays in effect.
- ADR 0023: a budget is a count, never a duration, with no exception. The fortnightly workflow of
  [#500](https://github.com/audio-dog/cogwork/issues/500) is not built. The Performance budget
  sensor adds its own scheduled workflow and its own `budget` verdict kind.
- [#500](https://github.com/audio-dog/cogwork/issues/500) and
  [#744](https://github.com/audio-dog/cogwork/issues/744) close as not planned.
  [#570](https://github.com/audio-dog/cogwork/issues/570) is not blocked on #500.
- `docs/research/preventing-test-suite-performance-drift.md` stays as research.
- Each push to `main` still runs the suite once, but turbo can replay cached tasks.
