# A six-agent baseline, and why the eight-agent question is still open

Measurement campaign for #414 (spec Phase 4), run on `6e62ac57` with
`configs/sensor/perf-campaign.mjs`. This document does one job well and names the job it failed: it gives
the performance sensor (#416) a measured baseline and thresholds, and it does **not** pick a
direction for the evidence-gated track.

**Read this first.** The campaign set the scheduler's global limit to 6 and then to 8, but the
second window never held 8 Runs. Realized concurrency was **5.88 and 6.25**. The board ran out of
admissible work — 22 Runs finished during the 40 minutes, averaging 24.3 minutes each, and slots
emptied faster than they could be refilled. So there is no 6-against-8 comparison here, and nothing
below should be read as one.

**Method.** Two 20-minute windows, back to back, real work items from the `cogwork` workspace
through the codex harness. Process health sampled every 10 seconds into the Telemetry store.
Numbers come from the daemon's own gauges and histograms, read back with window deltas.

---

## What the two windows actually were

| | Window 1 | Window 2 |
| --- | --- | --- |
| Configured limit | 6 | 8 |
| Realized concurrency, mean | **5.88** | **6.25** |
| Samples at the configured limit | 116 of 120 | **29 of 119** |
| Peak | 6 | 8 |

Window 1 is a clean, sustained six-agent load. Window 2 is not an eight-agent load.

## The six-agent baseline

Window 1, the sustained one. These are the numbers #416 should calibrate against.

| Signal | Value |
| --- | --- |
| Daemon loop delay p99 | median 22.6 ms, p90 24.8 ms, peak 44.6 ms |
| Main loop delay p99 | median 22.2 ms, p90 25.1 ms, peak 31.3 ms |
| Daemon heap | 237 → 242 MB, peak 261 MB — **6.1 % of a 4288 MB limit** |
| Renderer heap | 39 → 45 MB, peak 51 MB — **1.2 % of a 4192 MB limit** |
| Main heap | 27 → 31 MB, peak 31 MB — 0.7 % of limit |
| Run ledger append | 1981 appends, mean 0.47 ms, running max 14.0 ms |
| Harness event fold | 1981 folds, mean 0.67 ms, running max 14.6 ms |
| Control-store write gate wait | 132 waits, mean 0.00 ms, running max 0.01 ms |
| Scheduler tick | 238 ticks, mean 0.13 ms, running max 2.29 ms |
| File-diff `git diff` exec | 592 calls, mean 51.2 ms, running max 196.9 ms |
| Worktree ensure | 6 ensures, mean 8.1 s, running max 30.6 s |
| Events recorded | 2025 over 12 Runs — 1.7/second total, 0.29 per realized agent |
| `sandbox.file.diff` share | 13.9 % |
| Processes that died | none |

## Thresholds for the performance sensor (#416)

Snapshots arrive every 10 seconds, so "3 consecutive windows" is 30 seconds sustained.

| Signal | Six-agent baseline | Proposed threshold |
| --- | --- | --- |
| Daemon event-loop delay p99 | median 22.6, p90 24.8, peak 44.6 ms | **> 100 ms for 3 consecutive windows** |
| Daemon heap headroom | 4027 MB free of 4288 | **< 25 % of limit for 3 consecutive windows** |
| Renderer heap headroom | 4141 MB free of 4192 | **< 25 % of limit for 3 consecutive windows** |

**These rest on one 20-minute window on one machine.** 100 ms sits well above everything the
sustained six-agent state produced, so it will not fire on a healthy load; it is a first cut to be
re-fitted once a real eight-agent window exists. The heap thresholds have three orders of magnitude
of margin against anything measured; they are deliberately "about to die" signals, sized to the
failure #281 describes rather than to anything seen here.

**Do not ship an event-bus drop signal.** `cogwork_daemon_event_bus_dropped_events_total` never
reached the Telemetry store in either window. That is consistent with zero drops but does not prove
them — a counter that never increments may never snapshot. Settle it before treating it as a signal.

## What the second window does and does not say

Window 2 added 6 % more realized load and the daemon's tail degraded sharply:

| | Window 1 (5.88) | Window 2 (6.25) |
| --- | --- | --- |
| Daemon loop delay p99, p90 | 24.8 ms | **126.4 ms** |
| Daemon loop delay p99, peak | 44.6 ms | **449.1 ms** |
| Run ledger append, mean | 0.47 ms | **2.43 ms** |
| Harness event fold, mean | 0.67 ms | **4.11 ms** |
| Scheduler tick, mean | 0.13 ms | **4.02 ms** |
| `git diff` exec, mean | 51.2 ms | **94.7 ms**, running max **2426 ms** |
| Worktree ensure, mean | 8.1 s | **15.2 s**, running max **68.1 s** |

A 6 % load increase does not explain a fivefold p90. Something else about window 2 differs, and
this campaign did not isolate it. Two observations that constrain the search:

- **The Control-store write gate is not the cost.** It cost 0.00 ms mean and 0.05 ms peak across
  119 waits. Any design that starts from "the write gate serializes Run admission" is aimed at
  microseconds.
- **The file-diff and worktree paths carry the largest absolute durations by orders of magnitude** —
  a 2.4-second `git diff` and a 68-second worktree ensure, against a 164 ms worst ledger append.
  They are the better place to look next.

That is a lead, not a verdict. **This document does not pick the evidence-gated track's direction.**

## The two prior reports

**#281, engine heap exhaustion over hours — does not reproduce at this scale.** Daemon heap peaked
at 273 MB, 6.4 % of its limit, and sat at 211–231 MB two hours after the campaign with the app still
running. It grows under load and is reclaimed. Nothing resembles the saturated 4011 MB live set
#281 describes. The Control store was available throughout, so the in-memory fallback ledger was not
in play. This is evidence against #281 at six agents over 40 minutes; it is not evidence about three
hours.

**#24, renderer crash cascade — untouched.** The renderer never exceeded 1.6 % of its heap limit and
never died. Whatever kills the GPU process is not the heap curve. #24 needs its own reproduction.

## What is excluded, and why

**Every file-descriptor and process-count figure.** The sampler that produced them had two defects,
both fixed after the campaign: it counted `cwd`, `txt` and mapped regions as file descriptors
(about 50 % too high), and it labelled the engine's whole subtree "harness", so package managers,
build tools and shells were counted as agents. Its resident-memory column attributes multi-gigabyte
processes to the harness role that cannot be the engine's children — one carries a PID lower than
the engine's own. Suspect 3 (descriptor and process pressure) therefore has **no verdict here**.

**Any claim about eight agents.** The window labelled 8 held 8 in 29 of 119 samples.

## What a real campaign needs next

1. **Enough admissible work to hold 8 Runs for 20 minutes.** At the campaign's average Run length,
   that is roughly 16 items with no open blockers. Three remain on the board. This is the binding
   constraint, and it is not a tooling problem.
2. **The corrected sampler**, so suspect 3 gets a verdict.
3. **A settle gap between windows**, so Runs admitted under the old limit are not charged to the new
   one.
4. **The profiling flags off.** The campaign daemon ran under `--cpu-prof --heap-prof` throughout.
   The V8 CPU profiler holds its samples in the daemon heap and adds latency, so it perturbs the two
   signals the campaign exists to measure, and every number above carries that perturbation. No
   metric read back here requires it. `preflight` now leaves profiling off unless asked with
   `--profile`, and the readout says so when a run was profiled.

## A note for #416's design

This campaign is a rehearsal of what the performance sensor will do alone, and the first pass got it
wrong in four ways worth designing against:

- **Cumulative state read as a window.** Effect histograms accumulate from process start. Reading
  one snapshot as a window's total overstated appends by 93 % and understated mean latency by 39 %.
  A signal over a histogram must difference two snapshots and must treat `max` as a running maximum.
- **A failed read that looked like a healthy zero.** The readout's SQLite call swallowed its exit
  code, so "cannot open the database" and "no rows" were the same value. A sensor must fail loudly
  when its own state is unreadable, never quietly report calm.
- **Alarming on the configured value instead of the realized one.** Every rate was divided by the
  scheduler's limit rather than by `cogwork_scheduler_runs_in_flight`. The sensor must read what
  happened, not what was asked for.
- **Concluding from the metrics that happened to be queried.** The write gate, `git diff`, worktree
  ensure and scheduler tick timers were all in the store and all unread; the first conclusion named
  the one path the data contradicts. This is the argument for #416's enumerated signal set: a fixed
  list with fixed semantics, not a judgement over whatever is at hand.
