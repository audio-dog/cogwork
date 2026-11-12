# 0026 — Test-suite cost is a per-test budget measured by seed runs

- **Status:** accepted
- **Date:** 2026-09-23

## Context

The pull-request test step drifted from ~77s in mid-August to 147–220s in late September, on a
suite of ~2,230 tests. Meanwhile the self-correction loop ADRs
[0021](./0021-the-performance-sensor-files-its-own-tickets.md)/[0022](./0022-a-sensor-lives-where-its-signal-is-produced.md)
designed for exactly this stalled one step from done: the comparison tool and the filer landed
([#499](https://github.com/taylorfsteele/cogwork/issues/499)), but the schedule and the
`issues: write` grant never did. [#500](https://github.com/taylorfsteele/cogwork/issues/500) parked at
`ready-for-human` on two recorded blockers — `test:compare` permitted cache reads (a cached side
measures 1.6–2.2s against 117–166s real, which is no measurement at all), and #498 closed without
recording a materiality threshold while the ADRs forbid guessing one. Zero `origin:selfperf`
tickets have ever been filed. The sensor never ran, and the maintainer experienced the whole
initiative as having silently vanished.

Four measured facts from the September 10–11 workflow artifacts shape the mechanism.

**Within one job, the measurement is tight; across jobs, it is useless.** Two same-SHA null
comparisons put the within-job noise at a confidence interval of [0.935, 1.056] on the median
ratio — about ±6%. The same commit measured in two different jobs came out 101s and 156s. Any
mechanism may compare medians gathered inside jobs; no mechanism may compare one job's number to
another's.

**Concurrency tuning does not move the suite.** `TURBO_CONCURRENCY=1, VITEST_MAX_WORKERS=3` and
`2/1` were both measured against the defaults on the runner: inconclusive, no significant
difference. The tuning lever [#497](https://github.com/taylorfsteele/cogwork/issues/497) waited on is
measured dead.

**The caches never warm.** No workflow runs on push to `main`, so no turbo cache entry ever exists
at the default branch's scope. GitHub grants every ref read access to that scope — and scopes a
pull request's own cache entries to its merge ref, invisible to everyone else. So nearly every
pull-request and merge-queue run pays the full uncached cost.

**The cost is starvation, not test bodies.** The uncached suite runs in 17s on the maintainer's
18-core machine and 101–156s on the 4-vCPU runner. Roughly 200 tests run real `git` subprocesses
and real sandboxes, and 62 lint fixtures each spawn Biome; on 4 vCPUs that work queues.

The maintainer's requirement: the `pnpm test` step at 50–70 seconds uncached at today's size, a
target that scales as the project grows, and a loop that notices and files work when the suite
drifts off it — without a human watching.

## Decision

**Every push to `main` performs a seed run: one full uncached suite execution that is both the
measurement and the cache.** The workflow forces task execution (no cache reads), records the
suite duration and test count, then saves the turbo cache at the default branch's scope, where
every pull-request and merge-queue run can restore it. One run serves both masters: the felt PR
step drops to the changed packages' cost, and the project gains one clean, comparable, uncached
sample per merge — a cadence no fortnightly schedule can match.

**The budget is 30 milliseconds per test, asserted on the rolling median over the last ~20 seed
runs.** Per test, because the maintainer's target is a ratio — the suite may grow, and its cost
should grow in proportion, not in surprise. 30 ms, because 2,230 tests at 50–70s is 22–31 ms/test,
and the SRE Workbook's two-significant-figures rule makes the number read as a decision. A weekly
scheduled sensor reads the seed-run history and files one thin evidence ticket at `needs-triage`
plus `origin:selfperf` on breach, under ADR 0021's unchanged contract — fingerprint, tracker-derived
dedup, filing cap, re-file never reopen. Test count is always reported beside duration, so the
suite cannot look healthy by shrinking (0022's rule), and the per-test normalization cannot look
healthy through outliers because of the second budget:

**A second budget caps the slowest single test file.** The maintainer's observation — slow tests
are mostly an outlier problem — makes the median blind spot concrete: many small tests can hide one
pathological file. The cap's number is not set here; it waits on the first per-package/per-file
timing report, because thresholds come from measured baselines (0021) and this repo has now
twice paid for remembering that.

**This is a deliberate carve-out from 0023's "a budget is a count, never a duration."** That
rule's evidence was small-sample noise on heterogeneous machines — a 14–56s spread on one laptop.
A rolling median over ~20 same-fleet, within-job, uncached measurements is a different statistical
object; the same artifacts that killed cross-job comparison show within-job medians stable to ±6%.
Counts remain the rule for everything that is not this aggregated shape.

**The paired-commit comparison is re-scoped from schedule to bisection tool.** 0022's
fortnightly measurement loses its job to the seed runs, which produce more samples at better
cadence for free. The comparison workflow stays exactly as built — dispatch-only — and becomes the
instrument an agent points at two commits when the budget fires and someone has to say *which
merge did it*. Its materiality threshold is recorded now, from the null runs: **a comparison
verdict counts as a regression at median ratio ≥ 1.15** — the measured noise ceiling (1.056) plus
margin, rounded to a decision. This resolves #500's blocker; #500 is re-scoped to this ADR's
sensor.

**The lint-rule fixtures leave the `test` task.** They spawn Biome 62 times to prove the rules
block what they must block — a guard for rule changes, not for product changes, and mostly
consumed by agents. They move to their own task, run in CI only when the lint config changes, and
stay in the agents' gate when a rule is touched. This also deletes the lint package's
whole-monorepo input surface, which currently busts its cache on nearly every PR.

**Suites get cut by measurement and judgment, never by category.** The heavy suites are the
real-subprocess ones; the suspected-useless ones (instruction projection, probe-layer engine
tests) are behavior tests and mostly cheap. Any rewrite of a real-subprocess suite goes behind a
measured prototype: convert the slowest one to in-memory doubles at the `Git`/`Sandbox` service
seam, compare both shapes with the comparison tool on the runner, and commit to the pattern only
on a `faster` verdict at the recorded threshold.

**The local gate keeps the full suite, with honest timeouts.** Agents run everything before a
commit — this repo is not at the scale that forces colony's targeted gate — but the suites that do
real subprocess work declare explicit timeouts sized for contention, and local concurrency is
bounded, so a starved 5s default stops masquerading as a failure and burning a serial re-run.

## Considered Options

**A flake sensor riding CI retries.** Designed and deliberately deferred: there is no concrete
flake case on hand to test it against, and a sensor built without a real unhappy path is a
guessing sensor — the thing 0021 refuses. It gets built when a use case exists, on 0021's contract.

**Bigger runners.** An 8-vCPU runner roughly halves the wall clock immediately, for money,
forever, and removes the pressure that keeps the suite honest. The 17s local number proves the
work can be small. Revisit only if the budget cannot be met after the rewrites.

**A fast PR tier and a full nightly tier, or `--affected`.** Rejected again for 0022's reason:
every pull request runs every test, and a silently-never-run test is the class of invisible loss
the sensors exist to prevent.

**The rolling median of pull-request step durations as the budget's input.** The maintainer's
instinct — the data already exists in bulk. Correct until the caches warm; after that, a PR step
measures cache health, not suite cost. Seed runs measure the suite; the PR step stays what a
person feels.

**Deleting test categories now.** Irreversible signal loss for unproven savings, against the
maintainer's own read that most tests are legitimately useful and slowness is an outlier problem.

## Consequences

- Amends 0022: the fortnightly schedule is dropped in favor of the weekly read over seed-run
  history; the tool itself and "never compare across jobs" survive untouched — the sensor compares
  an aggregate of within-job measurements to a fixed allowance.
- Amends 0023: a budget may be a duration when it is per-test-normalized and aggregated over ~20
  same-fleet uncached runs. Counts remain the rule everywhere else.
- A new workflow on `main` gains the seed run; the weekly sensor workflow gains `issues: write`.
  Every merge to `main` costs one uncached full-suite run — ~2.5 minutes today, ≤ ~67s once the
  budget is met, which is the point.
- [#500](https://github.com/taylorfsteele/cogwork/issues/500) is unblocked and re-scoped;
  [#570](https://github.com/taylorfsteele/cogwork/issues/570)'s budget evaluation lands inside this
  sensor rather than the fortnightly one; [#497](https://github.com/taylorfsteele/cogwork/issues/497)
  is answerable from the September artifacts: the tuning it waited on measures as no effect.
- The 50–70s target is met by two independent legs: the budget holds the uncached suite at
  ≤ 30 ms/test, and the seed-run cache makes the felt PR step smaller than that. Either leg
  failing files work; neither gates a merge.
