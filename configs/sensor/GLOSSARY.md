# Sensor

The self-correction sensing layer: the tools that measure the app's own health signals in CI and
file work items when a signal degrades or misses its target. The mechanism contract is ADR 0021;
the placement rule ("a sensor lives where its signal is produced") is ADR 0022.

## Language

**Sensor**:
Deterministic code that watches one enumerated signal and files a work item at `needs-triage` with
`origin:selfperf` when the signal warrants it. Never a model, never a merge gate.
_Avoid_: monitor, watcher, detector

**Budget**:
A standing target the app must meet; missing it files work. A budget fires on the standing
condition, not on a transition.
_Avoid_: threshold (that is a sensor's firing point, not the target), SLA

**Seed run**:
The run on each push to `main` that saves the shared turbo cache. Pull-request and merge-queue runs
restore that cache.
_Avoid_: warmup run, baseline run
