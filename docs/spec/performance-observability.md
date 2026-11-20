# Performance observability — implementation plan

Executes [ADR 0020](../adr/0020-telemetry-is-local-first-in-its-own-store.md) (local telemetry
store) and [ADR 0021](../adr/0021-the-performance-sensor-files-its-own-tickets.md) (the
performance regression sensor), plus the defect fixes and measurement campaign around them. The ADRs are the
*what and why*; this plan is the *how*, and where they disagree the ADRs win.

The evidence base is four research documents, each cited to primary sources or `file:line`:

- `docs/research/cogwork-performance-bottleneck-survey.md` — where the cost lives at 6–8 agents,
  ranked, with crash candidates.
- `docs/research/electron-node-performance-practices.md` — which diagnostic applies to which
  process; the daemon is plain Node, so the full toolbox applies via `engine-command.ts`.
- `docs/research/effect-observability-for-performance.md` — the Effect v4 APIs, verified against
  the pinned rc.
- `docs/research/repeatable-performance-benchmarking.md` — replay as the measurement layer;
  statistical hygiene; what the vendored repos do.

Before writing code: invoke `/effect-ts`, and read `docs/agent-patterns/effect-observability.md`
plus the pattern docs each ticket names.

## Shape: two tracks

**Track 1 — fast track.** Defect-shaped fixes that need no profiler to be wrong. They land now,
each with before/after numbers captured through the replay harness once it exists (counts
immediately, timings when comparable).

**Track 2 — evidence-gated.** The architectural swings — event-pipeline batching, IPC coalescing,
moving off the synchronous SQLite driver, any process-topology change. None of these starts until
the measurement campaign confirms which suspects are real. Their designs get their own ADRs then.

The symptom's ranked suspects, for orientation (survey §Ranked findings): (1) the per-event,
per-subscriber pipeline with no batching; (2) unbounded renderer accumulation with O(n²) transcript
re-fold; (3) the file-diff feed's subprocess storm and growing payloads; (4) the synchronous shared
SQLite connection and write gate; (5) the run-start IO spike; (6) sliding event-bus drops.

## Phase 1 — instrumentation (ADR 0020)

1. **Telemetry store.** `~/.cogwork/telemetry.db`, its own `SqliteClient` layer, never the Control
   store connection. Tables: `spans` (name, trace id, span id, parent, start, duration, exit,
   attributes JSON), `metrics` (timestamp, name, type, attributes JSON, state JSON). Batched
   writes copying `OtlpTracer`'s batching pattern; a custom `Tracer.make` whose `span().end`
   enqueues a row. Retention: prune by age and size cap on the worktree-maintenance cadence.
   Settings: `telemetry` (default on) gates the sink; `profiling` (default off) gates heavy tools.
2. **Duration metrics.** `Metric.timer`s on the hot seams the survey names: harness event fold
   (per-event cost), ledger append, Control-store write gate wait, scheduler tick, worktree
   ensure, `git diff` exec in the file-diff feed, reconcile poll.
3. **Health gauges, all three processes.** Event-loop delay (`monitorEventLoopDelay` p99) and ELU
   deltas, heap used vs `heap_size_limit`, plus `Metric.enableRuntimeMetricsLayer` in the daemon —
   the probe that rules the suspected fiber leak behind #281 in or out.
   Renderer: heap, protocol-inbox depth, events applied per second. Main: loop lag, IPC frames
   forwarded per second. Renderer and main report into the daemon's store over the existing RPC /
   IPC seams.
4. **Crash forensics.** Daemon argv gains `--report-on-fatalerror` and
   `--heapsnapshot-near-heap-limit=3` unconditionally via `engine-command.ts`; the supervisor logs
   `'close'` codes and signals; Crashpad stays local (`uploadToServer: false`). A `profiling`-gated
   path injects `--cpu-prof`/`--heap-prof` and enables an on-demand heap-snapshot command.
5. **Read path.** The store itself: the slow-spot query (`GROUP BY name ORDER BY p95 DESC` over
   spans) and its metric-reading siblings, documented beside the schema. No bespoke dump command —
   SQL over the store is the surface ADR 0020 promises.

## Phase 2 — replay harness

The measurement instrument for both tracks (benchmarking research §recommendation):

1. **Fixture export.** A command that exports a run's `run_events` rows (with timestamps) to a
   committed fixture file — run events expire after 30 days, so chosen recordings must be exported
   promptly. Record a small set of representative real runs at 6–8 agent scale.
2. **Replay runner.** A harness runner registered like the real ones (`apps/cli/src/rpc.ts:82-86`)
   that streams a fixture's events at recorded speed (or a multiplier), through the whole real
   pipeline — recorder, ledger, bus, NDJSON, IPC, renderer. The executor tests' fake runners
   (`Stream.fromArray`) prove the seam.
3. **Scoring.** Counts first (events processed, SQLite inserts, IPC frames, bytes, drops) —
   machine-independent, CI-gateable. Timings second, compared locally only, with the hygiene
   rules: warm-up, ≥10 runs per side, compare distributions, no significance → no conclusion.
   Effect's `runtimeperf` harness (`.repos/effect`) is the design to copy for base-vs-head runs.
4. **Limits.** Replay does not exercise agent subprocesses or worktree IO; the in-situ gauges
   cover those. Renderer numbers during replay come from the Phase 1 gauges plus a DevTools
   Performance recording when needed.

## Phase 3 — fast-track fixes (Track 1)

Each lands with replay counts before/after; order by crash risk:

1. **Renderer transcript accumulation.** `runActivityAtom` accumulates every RunActivity of a
   watched run unbounded, and `foldTranscript` re-folds the whole array per event — O(n²)
   (`apps/desktop/src/renderer/src/daemon/atoms.ts:20-22`,
   `components/run-transcript.tsx:71-76`). Fix: fold incrementally into bounded state; bound the
   protocol inbox (`daemon/protocol.ts:54`) or make its depth visible.
2. **Ledger read-back amplification.** Every run mutation re-reads and Schema-decodes all of the
   run's events to compute `eventCount`, and `listRuns` carries a correlated `count(*)` per row
   (`packages/engine/src/run-ledger.ts:305-312`, `apps/cli/src/ledger.ts:490-571`). Fix: keep the
   count, don't recount.
3. **File-diff feed.** One `git diff` subprocess per file event, diffs grow monotonically against
   the base SHA, build directories are not ignored
   (`packages/engine/src/tools/file-diff-feed.ts:70-146`). Fix: debounce per file, ignore
   configured build output, cap payload size, and stop shipping full diff text on every hop.
4. **Event-bus loss visibility.** `PubSub.sliding(1024)` silently drops oldest under exactly the
   load being investigated (`packages/engine/src/daemon-event-bus.ts:42-43`). First slice is
   honesty, not policy: count drops as a metric, log on transition, surface in the UI. A policy
   change is Track 2.

## Phase 4 — measurement campaign (human-in-the-loop)

With Phases 1–2 landed: reproduce the 6–8 agent load (real, plus replay at multiplier), and
answer, in order (survey §Measure first): which process dies at 8; renderer heap over a long run
with an item tab open; daemon event-loop delay and insert latency at 6–8; fd and child-process
counts; events/second per agent and the `sandbox.file.diff` share. Output: a findings doc in
`docs/research/`, thresholds and baselines for the sensor, and a confirmed/killed verdict per
Track 2 suspect. Track 2 designs and their ADRs start from that document.

## Phase 5 — the performance regression sensor (ADR 0021)

Built last, thresholds from Phase 4's baselines: `createIssue` on the issue tracker port (GitHub
first); the sensor service in the daemon (enumerated signals, N-consecutive-windows transition
firing, fingerprint marker, tracker-derived dedup, "fired again" comments, daily cap,
re-file-don't-reopen); `origin:selfperf` label. Closure stays human; VERIFY is explicitly out of
scope. Independently: widen the reconcile observation window past one page of 100
(`packages/engine/src/github/client.ts:589`) so machine-filed tickets cannot hide real work.

## Phase 6 — performance budgets (ADR 0023)

Phases 1-5 all sense a change for the worse; none of them speaks while the app is uniformly slow
and staying slow. The measurement campaign found the two largest costs in the system — a worktree
ensure averaging 8.1s, a `git diff` exec peaking at 2426ms — and neither is a regression, so no
sensor built so far will ever file about them.

A **performance budget** is a named count of the app's own work with a target below what the app
does today. Missing it is the normal state, and missing it files work. Counts and never durations:
ADR 0022 measured the same suite at 14s to 56s on ambient load alone, and resource contention is
worse on a working laptop than on a CI runner. Nothing here gates a merge — a gate at today's count
declares today's count acceptable, and a gate at the target fails every pull request.

Placement follows ADR 0022: the count is produced by running the engine under a swapped `Git`
service layer, so it is measured in CI. Phase 6 adds its own scheduled workflow (#570), and hands
its verdict to the filer of #499 — one filer, one cap, one fingerprint contract, at `needs-triage`
with `origin:selfperf`. The existing pipeline carries the
ticket from there, which is the loop closing on the app's own speed.

First budget: git invocations per worktree ensure, seeded about 20% under the measured count and
rounded to two significant figures. When a budget is met it is lowered again, and a budget kept
current is its own regression guard.

Out of scope: duration budgets, any merge gate, and the `git diff`-per-file-event defect, which is
a known cost with a measured size and belongs on the board as ordinary work rather than waiting for
a sensor to notice it.

## Glossary

New terms land in `packages/engine/GLOSSARY.md`: **Telemetry store**, **Performance regression sensor**, **Performance budget sensor**, **Performance budget**,
**Replay runner**, **Health signal**, **Fingerprint**.
