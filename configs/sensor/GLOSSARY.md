# Sensor

The self-correction sensing layer: the tools that measure the app's own health signals in CI and
file work items when a signal degrades or misses its target. The mechanism contract is ADR 0021;
the placement rule ("a sensor lives where its signal is produced") is ADR 0022; the test-suite
budget is ADR 0026.

## Language

**Sensor**:
Deterministic code that watches one enumerated signal and files a work item at `needs-triage` with
`origin:selfperf` when the signal warrants it. Never a model, never a merge gate.
_Avoid_: monitor, watcher, detector

**Budget**:
A standing target the suite or the app must meet; missing it files work. A budget fires on the
standing condition, not on a transition.
The slowest-test-file budget is 14,000 ms, rounded to two significant figures from the first timing
report's 13,565 ms measurement ([run 36749774543](https://github.com/taylorfsteele/cogwork/actions/runs/36749774543)).
_Avoid_: threshold (that is a sensor's firing point, not the target), SLA

**Seed run**:
The uncached full-suite run on each push to `main` that both measures suite cost (duration and
test count) and saves the shared turbo cache for pull-request and merge-queue runs.
_Avoid_: warmup run, baseline run

**Baseline**:
The commit a paired comparison measures against. It moves deliberately — after a regression is
resolved — never automatically.
_Avoid_: reference commit

**Materiality threshold**:
The minimum median ratio a paired comparison must breach before its `slower` verdict counts as a
regression. Recorded from measured null-run noise, never guessed.

**Verdict**:
A comparison's outcome: `faster`, `slower`, or `inconclusive`. `inconclusive` is a first-class
result, not a failure.

**Timing report**:
The per-package and per-file duration breakdown a measured run produces. Cut and cap decisions
read it; nobody cuts by category.
