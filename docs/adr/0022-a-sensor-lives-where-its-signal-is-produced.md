# 0022 — A sensor lives where its signal is produced

- **Status:** accepted
- **Date:** 2026-09-03
- **Amended by:** [0026](./0026-test-suite-cost-is-a-per-test-budget-measured-by-seed-runs.md) — the fortnightly schedule is replaced by a weekly read over per-merge seed runs; the comparison tool is re-scoped to on-demand bisection.

## Context

ADR [0021](./0021-the-performance-sensor-files-its-own-tickets.md) gave cogwork its first
non-tracker sensor: deterministic engine code that watches the telemetry store and files a
`needs-triage` ticket when the app's own health degrades. The test suite is the second signal
worth sensing, and it arrives from somewhere else.

The suite had been drifting. Issue [#432](https://github.com/taylorfsteele/cogwork/issues/432) fixed
the drift — package test tasks were serialised behind each other, and the slowest suite queued on
one `git` subprocess at a time — and took an uncached `turbo run test` from 36.4s to 17.0s. The
question this ADR answers is what stops it happening again without a person noticing that it has.

Three measured facts shape the mechanism.

**Wall clock here is not a number you can compare.** Repeated identical full runs on one machine
ranged 14s to 56s purely on ambient load. Any threshold on a raw duration is a coin toss, and
ADR 0021 already commits us to the opposite: *"a wrong ticket costs more trust than a missed
one."*

**Nobody gates on it.** Across the four vendored repos, every one that measures timing keeps
timing out of its CI gates; the two that do gate, gate machine-independent counts. Effect built
exactly the detector we would want — a seeded bootstrap confidence interval over paired
measurements, `bootstrapMedianLogRatio` at
`.repos/effect/packages/effect/runtimeperf/stats.mts:61`, behind a `--fail-on-regression` flag —
and wired it into no workflow. It is a `package.json` script run by hand. That is evidence about
what a timing gate costs in trust, not about whether the measurement is sound.

**The signal is not produced where the daemon lives.** Test duration happens on a GitHub runner.
The supporting survey is in
`docs/research/preventing-test-suite-performance-drift.md`; the guardrail precedents this reuses
are in `docs/research/performance-feedback-loop-into-tracker.md`.

## Decision

**A sensor lives where its signal is produced.** ADR 0021 put the sensor in the engine because
that is where its signal was — *"cogwork's daemon is already resident on the machine where the
signals live. A second process would duplicate auth, config, and scheduling the daemon already
has."* That reasoning is sound and it does not transfer: this signal is produced on a GitHub
runner, and GitHub Actions supplies auth (`GITHUB_TOKEN`) and scheduling (`on: schedule`)
natively, so nothing of cogwork's credential store or scheduler is duplicated. The out-of-band
filer ADR 0021 rejected is the right shape once the signal is out of band. **The test-suite
sensor is a scheduled GitHub Action, not engine code.**

**It is a tool that also runs on a schedule, and never a merge gate.** The measurement lives in a
committed `test:compare` script so a person or an agent can ask the question at any time. Nothing
about test duration blocks a merge. A gate on a 14s–56s quantity would be disabled within a
month, and then there would be neither a gate nor a tool.

**It compares two commits, never two measurements.** One job checks out current `main` and the
baseline commit, measures both on the same runner minutes apart over five paired rounds, and
decides with a bootstrap confidence interval on the median ratio under a fixed seed, with
`inconclusive` as a first-class verdict. No number is ever compared across runners or across
time. This is what lets the cadence be slow: the confidence lives inside a single job, so one run
yields one trustworthy verdict and may file on the first breach rather than waiting for
consecutive windows to agree.

**The cadence is fortnightly.** Daily was rejected as more than the problem warrants. Consecutive-
window confirmation, which ADR 0021 relies on, is unavailable at that cadence — three fortnightly
runs is six weeks to notice anything — which is precisely why the confidence moved inside the job.

**The baseline is a commit, and it moves deliberately.** It advances when a regression is
resolved, never automatically. An auto-advancing reference hides gradual creep: at six percent a
fortnight every individual comparison reads as no significant change while the suite doubles in a
year, which is the drift this ADR exists to catch. Recomputing the reference is work an agent can
do.

**What it files is ADR 0021's contract, unchanged.** One thin evidence ticket at `needs-triage`
plus `origin:selfperf`, carrying the signal line, both medians, the ratio, the confidence
interval, the round count, the two commits compared, and a link to the workflow run. No
diagnosis — that is triage's job. The fingerprint is a stable string over (signal, subsystem,
direction) with measurements excluded, carried as a `<!-- cogwork:… -->` marker. Dedup derives
from the tracker: scan open `origin:selfperf` issues for the fingerprint, and an open match gets a
"fired again" comment instead of a second issue. Filings are capped. Recurrence re-files with a
cross-link and never reopens a human's close.

**The threshold is not set here.** It waits on measurement from the real runner, per ADR 0021 —
thresholds come from measured baselines, and a guessing sensor files wrong tickets. Bias it
toward silence.

## Considered Options

**A merge gate on time added per test added.** The original ask. It divides two noisy numbers, and
the prior art is unanimous that this is the thing teams build and then decline to enforce.

**A GritQL plugin capping tests per file.** Counting is not expressible in Biome 2.5.11's GritQL
subset, measured rather than assumed. The failure mode would be silent wrong counts, which is
worse than no rule.

**CodSpeed.** Its instrument excludes system calls by design. This suite is 60–75% syscall wait,
so it would report a flat line while the suite doubled. A category error, not a cost question.

**Datadog Test Optimization as a gate.** Its PR Gates offer no duration rule type.

**Vitest `--shard` through Turborepo passthrough arguments.** Documented to bust the cache for
every task, which trades away the per-package caching that makes the current suite cheap.

**`sequence.concurrent: true` globally, on Effect's model.** Vitest's own default is serial, and
one of the four vendored repos deviates. Effect can afford it because its subprocess and container
suites are the exception it opts out; cogwork drives agent subprocesses, so those suites are the
norm and the opt-out list would be the majority case. Measured directly: sixteen tests broke, and
they broke load-dependently and order-dependently, which is the worst failure shape to install as
a default.

**`turbo run test --affected` in CI.** Trades the guarantee that every pull request runs every
test for seconds on a suite that already resolves in 0.12s from a warm cache. The failure — a
mis-detected graph edge meaning a test silently never runs — is the same class of invisible loss
the sensor exists to prevent.

**Measuring on the maintainer's machine so the engine could own the sensor.** That is the
environment whose noise made a gate impossible; trending there would be the worst of both.

**A transport from CI into the local telemetry store, keeping ADR 0021's mechanism.** Adds a
moving part between the measurement and the ticket, and the daemon must be running to ever notice.
A sensor that fails quiet is worse than no sensor.

## Consequences

- The sense step now has an instance that is not engine code. ADR 0021's mechanism — enumerated
  signals, fixed thresholds, transition firing, tracker-derived dedup, bounded emission, re-file
  never reopen — is reusable independent of where a sensor runs, which is the part worth keeping.
- The pull-request workflow gains `issues: write`; it grants only `contents: read` today.
- Every CI job gains `timeout-minutes`, which none has. It is a ceiling against a hang, not a
  performance gate: set far enough above the measured spread that only a hang or catastrophic
  drift can trip it.
- CI publishes the `turbo run test --summarize` JSON as an artifact and a short table in the job
  summary, reporting **test count beside duration**. Reported together, a suite cannot look
  healthy by shrinking — the one way a duration number can improve while the thing it stands for
  gets worse.
- `turbo run test --concurrency` stays untuned until numbers from the four-vCPU runner exist.
  Eight packages each start their own Vitest pool there, and the arithmetic says that contends —
  but a local measurement on an eighteen-core machine already misled this work once, when
  `isolate: false` looked sixty percent faster locally and was both slower and deterministically
  broken at `--maxWorkers=4`.
- `noFocusedTests`, `noSkippedTests`, `noExportsInTest` and `noDuplicateTestHooks` switch on. The
  suite has zero violations of all four today, so this is insurance against a later `it.only`
  quietly shrinking the suite, not a fix for anything present.
- ADR 0021 recorded that machine-filed tickets could push real work out of the engine's sight,
  because the reconcile poll read one unpaginated page of 100 open issues. That is no longer true:
  `collectIssuePages` walks pages until a short one (`packages/engine/src/github/client.ts:638`),
  landed in `fd2b9b2e` on the same day 0021 was accepted. The observation window it asked to have
  widened has been widened, so the tracker-noise concern is now bounded by the filing cap alone.
