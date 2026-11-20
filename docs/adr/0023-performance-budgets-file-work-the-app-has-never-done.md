# 0023 — Performance budgets file work the app has never done

- **Status:** accepted
- **Date:** 2026-09-08
- **Amended by:** [0040](./0040-the-test-suite-cost-sensor-is-removed.md). A budget is a count, never
  a duration, with no exception. The fortnightly workflow of #500 is not built. This replaces the
  amendment from ADR 0026.

## Context

Three ADRs now sense performance, and all three sense the same thing: a change for the worse.
ADR [0021](./0021-the-performance-sensor-files-its-own-tickets.md) fires when a health signal
crosses a threshold it was previously under. ADR
[0022](./0022-a-sensor-lives-where-its-signal-is-produced.md) fires when the test suite is slower
than a baseline commit. ADR [0020](./0020-telemetry-is-local-first-in-its-own-store.md) supplies
the store both read from. Every one of them is quiet while the app is uniformly slow and staying
slow.

The measurement campaign for [#414](https://github.com/taylorfsteele/cogwork/issues/414) made the gap
concrete. The two largest costs it found — a worktree ensure averaging 8.1s and peaking at 68.1s,
and a `git diff` exec averaging 94.7ms and peaking at 2426ms — are not regressions. They are what
the app has always done. No sensor in 0021 or 0022 will ever file a ticket about either, because
neither ever crosses from good to bad. The campaign's proposed regression threshold makes the
point sharper still: daemon event-loop delay p99 alarms above 100ms against a healthy p90 of
24.8ms, so the app may become four times slower in silence and every sensor stays correct.

The maintainer's requirement is a loop that makes the app faster, not only one that stops it
getting slower.

## Decision

**A performance budget is a target the app has never met, and missing it files work.** This
inverts 0021's premise. 0021 fires on a *transition* and re-arms on recovery; a budget fires on a
*standing condition* and goes quiet only when the condition ends. Nothing has to change for a
budget to file. That is the point.

**A budget is a count, never a duration.** ADR 0022 measured the same machine's identical test
runs at 14s to 56s on ambient load alone, and the research behind it found that of the four
vendored repos, every one that measures timing keeps timing out of its gates while the two that
gate, gate machine-independent counts. Established practice agrees and explains why: Lighthouse
rates client hardware variability, resource contention and network as high-impact noise, and all
three land on timings while none touch counts. One finding decides it for a desktop app — resource
contention is *worse* on a working laptop than on a CI runner, because the developer's own
activity shares the silicon with the measurement. Durations remain worth reading; they are how a
budget is chosen, never what it asserts.

**A budget never gates a merge.** A gate set at the current count declares the current count
acceptable, which is the opposite of the intent. A gate set at the target fails every pull request
until the work is done. There is no useful position for it, and ADR 0022 already refused merge
gates for a related reason.

**The budget's target sits below current behaviour when it lands, and moves down when it is met.**
A budget equal to today's number files nothing and improves nothing. The web performance tradition
sets an interim target 20% better than the current number, on the basis that 20% is roughly the
smallest difference a person perceives; the SRE Workbook adds that a target should be rounded to
about two significant figures so it reads as a decision rather than as a measurement. Both apply.
When a budget is met, it is lowered again — and a budget kept current is its own regression guard,
since a count rising back above the new target files again without any separate detector.

**It lives where its signal is produced, and reuses what already exists.** ADR 0022's principle
decides the placement: a count of the engine's own operations is produced by running the engine,
which is cheapest and most deterministic under a swapped service layer, so it is measured in CI.
The fortnightly workflow of [#500](https://github.com/taylorfsteele/cogwork/issues/500) already has
the cadence, the runner and the permission to write issues, and the filer of
[#499](https://github.com/taylorfsteele/cogwork/issues/499) already implements 0021's contract —
fingerprint, tracker-derived dedup, filing cap, re-file rather than reopen. Budgets are a second
verdict kind into that one filer, at `needs-triage` with `origin:selfperf`, and the existing
pipeline carries the ticket from there.

**The first budget is git invocations per worktree ensure.** Every ensure runs `git.fetch`
unconditionally, then `listWorktrees`, then `remoteBranchExists`, then either `addWorktree` or
`syncBranch` (`packages/engine/src/worktree.ts:237-263`) — including on a resume where nothing has
changed. `Git` is a `Context.Service` (`packages/engine/src/git.ts:66`), so a counting layer
measures the count exactly and repeatably.

## Considered Options

**A ranked "slowest thing" report instead of budgets.** Always fires, because there is always a
slowest thing, so it can never go quiet. That collides with the product's precision-over-recall
rule — a wrong ticket costs more trust than a missed one.

**Drift detection against a rolling baseline.** This is a better regression sensor, not an
improvement mechanism. It still says nothing about a cost that has been constant and too high
since the day it was written.

**Budgets on durations with wide headroom.** Rejected on ADR 0022's measured evidence. Headroom
wide enough to survive a 14s-to-56s spread is wide enough to hide the regression it was meant to
catch.

**A separate origin label for budget tickets.** ADR 0022 already reuses `origin:selfperf` for a
second sensor, so the label denotes machine-filed performance work rather than one mechanism.
A third label would fragment the dedup scan for no reader's benefit.

## Consequences

- The board gains a class of ticket that is never urgent and never a defect. Triage sees an
  optimisation proposal where it previously saw only regressions, and the ticket body has to make
  that legible without a diagnosis.
- Every budget met makes the next one harder, by design. A budget that stops moving is a signal
  that the cost is near its floor, and lowering it further is then a decision to stop rather than
  an oversight.
- Nothing here measures user-visible latency. Counts prove the work got smaller, not that anyone
  noticed. The periodic duration readings stay the check that a budget still points at something
  that matters.
- The improvement loop is only as good as the fixture the count is measured against, and the
  committed replay fixture is a placeholder today.
