# 0020 — Telemetry is local-first in its own store

- **Status:** accepted
- **Date:** 2026-09-01

## Context

Running 6–8 concurrent agents makes the whole machine chug, and at 8 the app appears to crash.
The bottleneck survey (`docs/research/cogwork-performance-bottleneck-survey.md`) ranked the
suspects from code shape alone — no profiling was run, and the survey marks each unconfirmed
point *hypothesis to measure* — and today the measurements cannot exist. The engine names a span on every service method
(`Effect.fn("Service.method")`), yet all three telemetry signals are dropped unless
`OTEL_EXPORTER_OTLP_ENDPOINT` is set (`apps/cli/src/telemetry.ts`); no duration metric exists
anywhere in the workspace; the desktop main process has no tracer at all; and nothing measures
event-loop health in any process, despite "slow under load" being exactly an event-loop symptom
(`docs/research/effect-observability-for-performance.md`,
`docs/research/electron-node-performance-practices.md`).

cogwork runs single-user and local. Asking the one user to run an OpenTelemetry collector to find
out why their own app is slow is the wrong shape. The app must keep its own evidence.

## Decision

**Telemetry gets a local sink by default.** A custom `Tracer.make` writes every finished span —
name, duration, trace id, attributes, exit — as a row, batched, and a timer-driven
`Metric.snapshot` writes metric readings beside them. The OTLP export path stays exactly as it is,
an opt-in addition; local persistence is the default, not the fallback.

**The sink is its own SQLite file: `~/.cogwork/telemetry.db`.** Not the Control store. See
Considered Options — this is a deliberate, argued exception to ADR
[0015](./0015-one-control-store-with-engine-owned-migrations.md).

**All three processes are instrumented from the start.** The engine daemon fully (span sink,
`Metric.timer`s on the hot seams, event-loop delay and ELU gauges, heap gauges,
`Metric.enableRuntimeMetricsLayer` for fiber health); the Electron main process and the renderer
with the same health gauges (loop lag, heap used against `heap_size_limit`, ingest depth), shipped
to the same store over the seams that already exist. The leading crash candidate is the renderer,
so a daemon-only instrument would miss the process most likely to die.

**Consent is built in from day one.** One `telemetry` setting, default **on**, gates the local
sink; a second `profiling` setting, default **off**, gates the heavy tools (CPU profiles, heap
snapshots, injected via `engine-command.ts`). Nothing leaves the machine under either switch. The
switches exist for a present-day reason — a person's control over what the app writes to their own
disk, and profiling's real overhead — and they are also the seam any future consent question would
land on. Crash forensics flags (`--report-on-fatalerror`,
`--heapsnapshot-near-heap-limit`) ride the daemon's argv unconditionally: they cost nothing until
the process dies, which is exactly when the evidence is wanted.

**Retention is mandatory.** The daemon prunes the telemetry store by age and size cap on its
recurring worktree-maintenance heartbeat (run-event retention, by contrast, runs once at boot). The store is disposable by definition —
deleting the file loses diagnostics history and nothing else.

**The instrument measures itself.** The sink's own writes carry spans and a write counter, and its
overhead has a budget: if it costs more than about 1% of the daemon's time under load, spans get
sampled before anything else changes.

## Considered Options

**Extending the Control store (rejected, against ADR 0015's pull).** ADR 0015 decided one SQLite
database per machine and overruled a two-database split, warning that "once two databases are
normal the fourth is free." That precedent is real and this ADR does not wave it off. It is
answered on three grounds. First, the lock: SQLite serializes writers per file, the Control store's
one connection already takes a synchronous insert per harness event on the daemon's event loop, and
that write path is itself ranked suspect #4 in the survey — an instrument that queues behind the
thing it measures distorts every number it reports. Second, the lifecycle: the Control store is
authoritative, exactly schema-checked at boot, and converged by ADR 0015's own machinery; telemetry
is high-volume, disposable, and pruned — binding them means a telemetry schema tweak can refuse a
boot, and a store reset erases diagnostics history for no reason. Third, 0015's own membership
test: the store holds "durable, authoritative records" cogwork is authoritative *for*; telemetry
rows are observations *about* the process, authoritative for nothing, and no product feature may
ever join against them — the moment one wants to, that feature's data belongs in the Control store
and this ADR is the thing to revisit. The 149 MB run ledger that made retention mandatory in 0015
is the cautionary tale for adding an even higher-volume family to the same file and boot path.

**Log files only (`Logger.toFile`, JSON lines).** Cheapest, zero lock contention — but analysis
needs an import step, and the two consumers this store exists for (the slow-spot query and the
performance sensor of ADR 0021) both want to *query*, not scan. `GROUP BY name ORDER BY p95 DESC`
over span rows is the product of this decision. A structured log file may still ride along for
crash-adjacent logging; it is not the sink.

**OTLP to a bundled local collector.** Ships a second service to babysit inside a desktop app, and
every consumer then speaks OTLP instead of SQL. All cost, no additional evidence.

**Effect DevTools only.** Live inspection during development (`DevTools.layer`), zero persistence.
Worth wiring behind a dev flag, but it cannot answer "what was slow yesterday" and a sensor cannot
poll it.

## Consequences

- Every existing `Effect.fn` span becomes a queryable row the moment the layer lands; slow-spot
  analysis is a SQL query over the app's own store, readable by the maintainer, by a triage agent
  on the same machine, and by the performance sensor (ADR 0021).
- The telemetry store is the first second database file on a machine. The boundary rule that keeps
  ADR 0015 intact: authoritative product records never live here, and telemetry rows are never
  joined from product features. Wanting either is the signal to revisit both ADRs together.
- The daemon gains a small always-on cost (gauges, batched writes) that is itself measured; the
  heavy profiling path stays off until a person turns it on.
- `apps/cli/src/telemetry.ts` stops being the only telemetry composition point; each process host
  provides the sink layer beside its existing logger wiring.
