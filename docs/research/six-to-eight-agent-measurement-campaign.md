# What 6 and 8 concurrent agents actually cost

Findings from the measurement campaign for #414 (spec Phase 4). This document records a
confirmed-or-killed verdict per suspect in
`docs/research/cogwork-performance-bottleneck-survey.md`, the baselines and thresholds the
performance sensor (#416) should start from, and the evidence that points the evidence-gated track.

**Method.** Two 20-minute windows on one machine, back to back, driven by
`scripts/perf-campaign.mjs`: 6 concurrent Runs, then 8. Real work items from the `cogwork`
workspace through the codex harness, not replay. Process health sampled every 10 seconds into the
Telemetry store; file descriptors and child processes sampled every 5 seconds by
`scripts/process-pressure-sampler.mjs`. Commit under test `6e62ac57`, which contains the OOM fix
(#517), the bounded file-diff feed, and the renderer accumulation fix (#410).

**One-paragraph verdict.** The app did not die at 8 agents, and no process exited during either
window. The renderer is no longer a crash candidate: it peaked at 66 MB against a 4192 MB limit.
What degrades is the daemon's event loop, and it degrades in the tail only — the median barely
moves from 6 to 8 agents while p90 rises fivefold and the peak rises tenfold. Event volume does not
explain it: total events per second rose only from 1.7 to 1.9. The signature is contention on the
one synchronous SQLite connection, not a per-event pipeline carrying more traffic.

---

## The numbers

| | 6 agents | 8 agents |
| --- | --- | --- |
| Daemon loop delay p99 — median | 22.6 ms | 24.2 ms |
| Daemon loop delay p99 — p90 | 24.8 ms | **126.4 ms** |
| Daemon loop delay p99 — max | 44.6 ms | **449.1 ms** |
| Run ledger appends | 2011 | 4272 |
| Ledger append — mean | 0.47 ms | 1.48 ms |
| Ledger append — max | 13.99 ms | **164.18 ms** |
| Daemon heap | 208 → 261 MB | 216 → 273 MB |
| Renderer heap | 39 → 51 MB | 42 → 66 MB |
| Main heap | 27 → 31 MB | 26 → 35 MB |
| File descriptors, all roles | ~1388 per tick | ~1978 per tick |
| Harness processes | ~40 | ~68 |
| Events per second, all agents | 1.7 | 1.9 |
| `sandbox.file.diff` share of events | 13.9 % | 11.7 % |
| Processes that died | none | none |

Heap limits: daemon 4288 MB, main and renderer 4192 MB each. Descriptor soft limit 1048575.

## Verdict per suspect

**1. Per-event, unbatched pipeline — confirmed as a cost, killed as the explanation.** The pipeline
shape is real, but the survey assumed text deltas arrive "roughly per token". Measured, the whole
system records **1.7 to 1.9 events per second across every agent**. Going from 6 to 8 agents added
12 % more events per second while the loop-delay tail grew tenfold. Event volume is not what stalls
the daemon. The survey's ranked finding 1 overstates this path by roughly two orders of magnitude
under the codex harness.

**2. Unbounded renderer accumulation and O(n²) transcript re-fold — killed.** With an item tab open
for the whole campaign, the renderer peaked at 66 MB: **1.5 % of its 4192 MB limit**. #410 removed
this. It is not the crash at 8 and it is not a crash candidate at all at this scale.

**3. File-diff subprocess storm — killed as a crash cause.** `sandbox.file.diff` is 12 to 14 % of
recorded events, and the absolute event rate is low. Harness processes rose from ~40 to ~68 and
descriptors from ~1388 to ~1978, against a soft limit of 1048575 — four orders of magnitude of
headroom. The bounded feed holds.

**4. Synchronous shared SQLite connection and the Control-store write gate — confirmed, and this is
the finding.** Ledger appends roughly doubled (2011 → 4272) while the worst single append grew
**twelvefold** (13.99 → 164.18 ms) and the mean grew threefold. A tail that grows far faster than
the volume driving it is queueing, not load. Every append is a synchronous insert on the daemon's
one thread, and every `executor.execute` passes through the write gate's single permit before
claiming. Two more agents is enough to turn that from invisible into a 449 ms stall.

**5. Run-start IO spike — not isolated.** This campaign held a steady agent count and did not vary
run-start rate, so it neither confirms nor kills the `git fetch` and worktree-add spike. It stays
open.

**6. Sliding pubsub drops — unmeasured, and this is a gap.** The
`cogwork_daemon_event_bus_dropped_events_total` counter never reached the Telemetry store in either
window. Absence is consistent with zero drops but does not prove them: a counter that never
increments may simply never snapshot. **This must be settled before #416 treats drops as a signal.**

## The crash at 8 did not reproduce

Both windows ran their full 20 minutes. `daemonLostAt` is null for each, no `process-gone` or
`restart budget` line appears in the desktop log inside either window, and the only `Engine closed`
entries on the day are clean `code 130` shutdowns from before the campaign. On `6e62ac57`, with the
fast-track fixes landed, 8 concurrent agents degrade the app; they do not kill it.

## The two prior reports

**#281, engine heap exhaustion over hours — does not reproduce.** The daemon heap peaked at 273 MB,
6.4 % of its 4288 MB limit. Two hours after the campaign ended, with the app still running, it sat
at 211 to 231 MB. It grows under load and is reclaimed after. Nothing here resembles the saturated
4011 MB live set #281 describes. The in-memory fallback ledger was not in play — the Control store
was available throughout. Re-test #281 against this commit before treating it as open.

**#24, renderer crash cascade — not a renderer-heap story.** The renderer never exceeded 1.5 % of
its heap limit and never died. Whatever kills the GPU process with `exit_code=15`, it is not the
heap curve, so #24 needs its own reproduction and cannot be closed by this campaign.

## Baselines and thresholds for the performance sensor (#416)

Snapshots arrive every 10 seconds, so "3 consecutive windows" is 30 seconds sustained.

| Signal | Healthy (6 agents) | Degraded (8 agents) | Proposed threshold |
| --- | --- | --- | --- |
| Daemon event-loop delay p99 | median 22.6, p90 24.8, max 44.6 ms | median 24.2, p90 126.4, max 449.1 ms | **> 100 ms for 3 consecutive windows** |
| Daemon heap headroom | 4027 MB free of 4288 | 4015 MB free of 4288 | **< 25 % of limit for 3 consecutive windows** |
| Renderer heap headroom | 4141 MB free of 4192 | 4126 MB free of 4192 | **< 25 % of limit for 3 consecutive windows** |

100 ms sits above everything the healthy 6-agent state produced (max 44.6 ms) and below the
degraded state's p90 (126.4 ms), so it fires on sustained degradation and not on a single spike.
The heap thresholds have three orders of magnitude of margin against measured behaviour; they are
deliberately "about to die" signals, sized to the failure #281 describes rather than to anything
seen here.

Do not ship an event-bus drop signal until the counter is shown to reach the store.

## Where the evidence-gated track should go

The three candidate directions were pipeline batching, the SQLite driver, and event fan-out. The
evidence separates them:

- **Event fan-out is not the problem.** 1.9 events per second across 8 agents does not stress any
  fan-out.
- **Pipeline batching would buy little.** Batching helps when volume is the cost. Volume is not the
  cost.
- **The SQLite driver is where the cost lives.** The append tail grows twelvefold for a doubling of
  appends, on a synchronous driver that blocks the daemon's only thread, behind a single write
  permit that every Run start must cross.

**Recommendation: the next ADR takes the SQLite write path off the daemon's event loop**, and
should weigh an asynchronous driver against moving the writes to their own thread, and separately
question whether the Control-store write gate needs to serialize Run admission at all. Batching and
fan-out work should wait for evidence that does not yet exist.

## What this campaign cannot tell you

One machine, one harness (codex), one workspace, one repository, one 20-minute window per level. No
replay comparison was run, so there is no controlled before-and-after for any change. Run-start rate
was not varied. The event rates are specific to codex; a provider-runner campaign would exercise the
file-diff feed far harder and should be run before suspect 3 is considered settled for that path.
