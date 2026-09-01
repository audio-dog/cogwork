# Effect observability for performance work

**Question:** cogwork gets slow when 6–8 coding-agent subprocesses run at once. What does the
pinned Effect v4 rc offer for performance observability — spans, metrics, logs, export, fiber
introspection — and how can a local-first desktop app lean on it to find slow spots?

**Version ground truth:** the workspace pins `effect: 4.0.0-rc.112` and
`@effect/opentelemetry: 4.0.0-rc.112` in the `effect` catalog
(`pnpm-workspace.yaml`). Every API below was verified against the vendored v4 source in
`.repos/effect/packages/effect/src` — not against v3 memory. v3 names that do NOT exist in v4 are
called out explicitly.

**TL;DR:** Everything needed to find slow spots ships in core `effect`, not in add-on packages.
Spans come from `Effect.fn` / `Effect.withSpan` and cogwork already names a span per service
method. Metrics have a first-class in-process read path — `Metric.snapshot`, `Metric.value`, and
a human-readable `Metric.dump` — so a desktop app can poll its own metrics without any collector.
`Metric.enableRuntimeMetricsLayer` turns on built-in fiber-health metrics (`child_fibers_active`
gauge plus started/success/failure counters), the closest thing to event-loop health out of the
box. For export, v4 gives three paths: the `@opentelemetry/*` NodeSdk bridge cogwork already
wires in `apps/cli/src/telemetry.ts`, dependency-free OTLP-over-HTTP exporters in
`effect/unstable/observability`, and an Effect DevTools WebSocket layer for live local
inspection. The local-first options that need no network collector at all: `Logger.toFile`, a
custom `Logger.make` / `Tracer.make` writing to SQLite, and a timer-driven `Metric.snapshot`
poll. The biggest gaps today: no duration histograms anywhere in the workspace
(`Metric.timer` is unused), runtime fiber metrics are not enabled, the desktop main process has
no tracer at all, and telemetry only exports when an OTLP endpoint env var is set — there is no
local sink.

---

## 1. Tracing: modules and signatures

The tracer lives in core: `effect/Tracer` (`.repos/effect/packages/effect/src/Tracer.ts`).
There is no separate tracing package.

**Creating spans** (`.repos/effect/packages/effect/src/Effect.ts`):

- `Effect.withSpan(name, options?)` — wraps an effect in a child span; data-first and data-last
  overloads, and the data-last form accepts a function of the call args to compute options
  (`Effect.ts:8318`).
- `Effect.fn(name, options?: SpanOptionsNoTrace)` — a traced function constructor: every call
  runs inside a span named `name`, with optional static attributes (`Effect.ts:13605`). This is
  cogwork's house pattern (`Effect.fn("Service.method")`).
- `Effect.makeSpan` / `Effect.makeSpanScoped` / `Effect.useSpan` / `Effect.withSpanScoped` —
  manual span lifecycle (`Effect.ts:8235–8359`).
- `Effect.currentSpan` — the current `Span` or `NoSuchElementError` (`Effect.ts:8066`).

**Span options** (`Tracer.ts:246–276`, `SpanOptionsNoTrace`): `attributes`, `links`, `parent`,
`root`, `annotations`, `kind` (OpenTelemetry span kind: internal/server/client/producer/consumer),
`sampled`, and `level` — a per-span `LogLevel` that interacts with `Tracer.CurrentTraceLevel` /
`Tracer.MinimumTraceLevel` (`Tracer.ts:563, 592`) for level-based span filtering.

**Attributes and correlation:**

- `Effect.annotateSpans(effect, record)` — attributes on every span in a region
  (`Effect.ts:7994`).
- `Effect.annotateCurrentSpan(record)` — computed attributes on the span you are in
  (`Effect.ts:8036`).
- `Effect.linkSpans` — causal links between separate traces, e.g. retry attempts
  (`Effect.ts:8198`).

**The Tracer service** is a `Context.Reference` — `Tracer.Tracer` (`Tracer.ts:632`) — with a
tiny interface: one `span(options)` method returning a `Span`, plus an optional `context` hook
(`Tracer.ts:29–43`). `Tracer.make(options)` (`Tracer.ts:455`) builds one. A `Span`
(`Tracer.ts:372`) carries `name`, `spanId`, `traceId`, `attributes`, `status`, and mutators
`end(endTime, exit)`, `attribute(key, value)`, `event(name, time, attrs)`, `addLinks`. This
interface is small enough that a custom SQLite-writing tracer is an afternoon of work (section 4).

**Cost controls** (`.repos/effect/packages/effect/src/References.ts`):

- `References.TracerEnabled` (`References.ts:391`) — disable tracing for a subtree; cogwork
  already uses this on the reconcile poll (`packages/engine/src/reconcile.ts:283`).
- `References.TracerTimingEnabled` (`References.ts:547`) — turn off timestamp capture while
  keeping span structure.
- `Tracer.DisablePropagation` (`Tracer.ts:540`).

## 2. Metrics: types, snapshots, runtime health

All in core: `effect/Metric` (`.repos/effect/packages/effect/src/Metric.ts`).

**Metric types:** `Metric.counter` (`Metric.ts:2091`), `Metric.gauge` (`:2177`),
`Metric.frequency` (`:2271`), `Metric.histogram` (`:2350`, explicit `boundaries` required),
`Metric.summary` (`:2426`, quantiles), and `Metric.timer` (`:2531`) — a
`Histogram<Duration.Duration>` in milliseconds with default exponential boundaries
(0.5 ms × 2, 35 buckets, so ~0.5 ms to ~2.4 h). `Metric.linearBoundaries` and
`Metric.exponentialBoundaries` (`:3179, :3205`) build custom bucket sets.

**Writes:** `Metric.update` (`:2703`), `Metric.modify` (`:2641`),
`Metric.withAttributes(metric, attrs)` (`:2875`) for per-call dimensions, and
`Metric.CurrentMetricAttributes` (`:1608`) as a context reference that tags every metric update
in a region.

**Reads — the part that matters for a desktop app.** v4 metrics live in a plain
`Map` behind the `Metric.MetricRegistry` context reference (`Metric.ts:1640`), and three APIs
read it with no exporter involved:

- `Metric.value(metric)` (`:2591`) — one metric's state (histograms give `buckets`, `count`,
  `min`, `max`, `sum`).
- `Metric.snapshot` (`:2938`) — `Effect<ReadonlyArray<Metric.Snapshot>>`, every registered
  metric with id, description, type, attributes, and state. `Metric.snapshotUnsafe(context)`
  (`:3065`) is the synchronous form used by exporters.
- `Metric.dump` (`:2997`) — a formatted human-readable table of all metrics as a string. Perfect
  for a debug IPC command or a `cogwork` CLI subcommand.

**Runtime / fiber health — the closest thing to event-loop health.** v4 ships an optional
fiber-lifecycle metrics service (`Metric.ts:3244–3480`):

- `Metric.enableRuntimeMetricsLayer` (`:3374`) provides `Metric.FiberRuntimeMetricsImpl`, which
  maintains four built-in metrics (`Metric.ts:3214–3228`):
  - `child_fibers_active` (gauge) — current live child fibers; a leak shows as a climb.
  - `child_fibers_started`, `child_fiber_successes`, `child_fiber_failures` (incremental
    counters).
- `Metric.FiberRuntimeMetricsService` (`:3273`) is the hook interface —
  `recordFiberStart(context)` / `recordFiberEnd(context, exit)` — so a custom implementation
  can record fiber lifetimes per region or feed a leak detector. This is v4's replacement for
  v3-style `Supervisor` instrumentation (section 6).

There is no built-in event-loop-lag metric; that stays a five-line `setInterval` drift gauge fed
into a `Metric.gauge`, which then rides the same snapshot/export path.

## 3. Logging: levels, annotations, custom loggers, spans

Core modules: `effect/Logger` (`Logger.ts`), `effect/LogLevel`, plus log functions on `Effect`.

**Levels:** `Effect.log` / `logFatal` / `logError` / `logWarning` / `logInfo` / `logDebug` /
`logTrace` (`Effect.ts:13704–13863`), threshold via `References.MinimumLogLevel`
(`References.ts:349`) provided in a layer.

**Annotations:** `Effect.annotateLogs` (`Effect.ts:13944`) attaches fields to every log line in a
region; `Effect.withLogSpan(label)` (`Effect.ts:14061`) adds an elapsed-time label — cheap
"how long since X started" on every line, distinct from tracer spans.

**Custom loggers:** `Logger.make((options) => ...)` (`Logger.ts:471`) builds one from a function;
`Logger.layer([loggers], { mergeWithExisting })` (`Logger.ts:914`) installs it — exactly what the
desktop main process already does (`apps/desktop/src/main/logger.ts:21–23`). Formatters:
`Logger.formatStructured` (`Logger.ts:594`) emits `{ level, fiberId, timestamp, message, cause,
annotations, spans }` — annotations and log-spans are first-class fields, not string prefixes.
`formatJson`, `formatLogFmt`, `consolePretty` are variants. `Logger.batched` (`Logger.ts:702`)
wraps any logger with a flush window, and **`Logger.toFile(logger, path, { batchWindow })`**
(`Logger.ts:1004`) writes a string-output logger straight to an append-only file through
`FileSystem` — a zero-dependency local log sink.

**Logs relate to spans two ways:**

1. The default logger set is `[defaultLogger, tracerLogger]`
   (`internal/effect.ts:6267`). `tracerLogger` (`internal/effect.ts:6634`) turns every log call
   inside a span into a **span event** carrying the log annotations plus `effect.fiberId`,
   `effect.logLevel`, and pretty-printed cause. Exported spans therefore carry their logs with
   them for free.
2. OTLP log exporters attach `traceId`/`spanId` to log records, so logs and traces correlate in
   any backend.

## 4. Export paths, and local-first targets for a desktop app

Effect's own guidance (`.repos/effect/ai-docs/src/08_observability/index.md`): use the
lightweight Otlp modules from `effect/unstable/observability` in new projects; use
`@effect/opentelemetry` NodeSdk when integrating with an existing OpenTelemetry setup.

**Path A — `@effect/opentelemetry` (what cogwork uses today).** v4 modules:
`NodeSdk`, `WebSdk`, `OtelTracer`, `OtelMetrics`, `OtelLogger`, `Resource`
(`.repos/effect/packages/opentelemetry/src/`). `NodeSdk.layer` takes a `Configuration` with
`spanProcessor`, `metricReader`, and `logRecordProcessor` (each single or array,
`NodeSdk.ts:35–40`); `NodeSdk.layerEmpty` (`NodeSdk.ts:162`) is the no-op fallback. cogwork's
`apps/cli/src/telemetry.ts` already wires all three signals behind an
`OTEL_EXPORTER_OTLP_ENDPOINT` config gate. Cost: the whole `@opentelemetry/*` dependency tree.

**Path B — `effect/unstable/observability` (dependency-free OTLP).** Modules
(`.repos/effect/packages/effect/src/unstable/observability/`): `OtlpTracer`, `OtlpMetrics`,
`OtlpLogger`, `OtlpExporter`, `OtlpSerialization`, `OtlpResource`, and a combined
`Otlp.layer({ baseUrl, resource?, headers?, maxBatchSize?, *ExportInterval?, shutdownTimeout?,
... })` that posts to `/v1/logs`, `/v1/metrics`, `/v1/traces` (`Otlp.ts:35–85`). Requires only an
`HttpClient` and an `OtlpSerialization` implementation from the context — no `@opentelemetry/*`
packages. `Otlp.layerFromConfig` (`Otlp.ts:93`) reads standard `OTEL_*` env vars. The
agent-patterns doc already flags moving here as a deliberate future decision
(`docs/agent-patterns/effect-observability.md:109`).

**Path C — Prometheus pull.** `PrometheusMetrics.format` renders the registry in Prometheus text
format; `PrometheusMetrics.layerHttp` mounts a `/metrics` route on an `HttpRouter`
(`PrometheusMetrics.ts:103, 184`). The daemon already runs a local socket server, so a
scrape-or-curl endpoint is nearly free.

**Path D — Effect DevTools (live local inspection).** `effect/unstable/devtools`
(`DevTools.ts`, `DevToolsClient.ts`, `DevToolsSchema.ts`): `DevTools.layer(url?)` installs a
tracer that mirrors the current tracer and streams span snapshots, span events, and
**metric snapshots** over a WebSocket to `ws://localhost:34437` by default (`DevTools.ts:65`,
`DevToolsClient.ts:52–110`) — the Effect DevTools VS Code extension protocol. Zero backend, dev
loop only.

**Local-first targets — no network collector, fits a desktop app:**

| Target | Mechanism | Effort |
| --- | --- | --- |
| Structured log file | `Logger.formatJson` piped through `Logger.toFile` (`Logger.ts:1004`), batched | Trivial |
| Metrics on demand | IPC/CLI command returning `Metric.dump` or `Metric.snapshot` JSON | Trivial |
| Metrics history in SQLite | timer fiber: `Metric.snapshot` → insert rows (drizzle + `@effect/sql-sqlite-node` already in the workspace) | Small |
| Spans in SQLite | custom `Tracer.make` (`Tracer.ts:455`): `span()` returns a `Span` whose `end(endTime, exit)` queues a row insert; batch like `Logger.batched` | Medium |
| Live dev inspection | `DevTools.layer()` gated behind a dev flag | Trivial |
| Full OTLP to a local collector | Path A or B pointed at a localhost collector the app ships or the user runs | Existing |

The span-to-SQLite tracer is the highest-leverage piece for "find slow spots": every
`Effect.fn("Service.method")` span cogwork already creates becomes a queryable row
(name, duration, trace id, attributes), and slow-spot analysis is a `GROUP BY name ORDER BY
p95 DESC` query over the app's own store. The `Tracer` interface is 1 method + 1 optional hook,
and the OTLP tracer internals (`OtlpTracer.ts`) show the batching pattern to copy.

## 5. What cogwork already does, and the gaps

**Spans:** pervasive. `Effect.fn("Service.method")` across `packages/engine/src` (dozens of
files; e.g. 24 in `commands.ts`, 11 in `connection.ts`). `Executor.runClaimed` annotates logs and
spans once with the correlation object (`packages/engine/src/executor.ts:1586–1587`), and the
desktop `engine-supervisor` does the same per-region
(`apps/desktop/src/main/engine-supervisor.ts:164–211`).

**Metrics:** six module-scope constants, counters and gauges only —
`cogwork_reconcile_rate_limit_hits_total` (`packages/engine/src/reconcile.ts:36`),
`cogwork_scheduler_runs_in_flight`, `cogwork_scheduler_budget_used`,
`cogwork_scheduler_budget_exhausted_ticks_total`, `cogwork_scheduler_job_outcomes_total`
(`packages/engine/src/scheduler.ts:30–39`), and
`cogwork_recovery_crash_loops_capped_total` (`packages/engine/src/recovery.ts:35`).

**Logging:** the daemon uses the default loggers; the desktop main process bridges Effect logs
into `electron-log` via `Logger.make` + `Logger.layer` with `formatStructured`
(`apps/desktop/src/main/logger.ts`). Noise control exists in one place:
`References.TracerEnabled` disabled on the reconcile poll (`packages/engine/src/reconcile.ts:283`).

**Export:** one config-gated layer, `telemetryLayer` in `apps/cli/src/telemetry.ts`, provided
last in `apps/cli/src/commands.ts:296`. NodeSdk with all three signals — but only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set; otherwise `NodeSdk.layerEmpty` and everything is dropped.

**Gaps, in priority order for the slowness investigation:**

1. **No duration measurement anywhere.** `Metric.timer` is unused in the workspace. Spans carry
   durations but are dropped unless an OTLP endpoint is configured — so in the failing case (a
   user's desktop under load) latency data does not exist. A span-to-SQLite tracer or a handful
   of `Metric.timer`s around subprocess spawn, harness turnaround, control-store writes, and
   scheduler tick would make p95s visible locally.
2. **No local sink.** All telemetry assumes a network collector. Nothing writes to disk or the
   existing SQLite control store; `Metric.dump` is not exposed via any CLI/IPC command.
3. **Runtime fiber metrics are off.** `Metric.enableRuntimeMetricsLayer` is not provided
   anywhere, so fiber counts/leaks are invisible. One layer at the daemon edge turns them on.
4. **The desktop main process has no tracer/metrics at all** — only the electron-log bridge.
   Engine-supervisor spans go nowhere.
5. **No event-loop lag gauge** in either process, despite "slow under load" being exactly an
   event-loop symptom in an Electron main process.

## 6. Fiber-level introspection

**v3 memory that does not apply:** v4 has **no `Supervisor` module** (nothing in
`.repos/effect/packages/effect/src/`), no `Fiber.dump`/`Fiber.dumpAll`, and no
`FiberRefs`-based runtime metrics flag. What exists instead:

- **`Metric.FiberRuntimeMetrics`** (section 2) is the supervision hook: the runtime calls
  `recordFiberStart`/`recordFiberEnd(context, exit)` on every child fiber when the service is
  provided (`Metric.ts:3273–3374`). A custom implementation can time fiber lifetimes, count by
  region (via context), or detect leaks; the default one maintains the four `child_fiber*`
  metrics.
- **`Fiber.getCurrent()`** (`Fiber.ts:568`) returns the running fiber, and the `Fiber` interface
  (`Fiber.ts:70–92`) exposes `id`, **`currentOpCount`** (ops since last yield — a direct "is
  this fiber hogging the loop" probe), `currentSpan`, `currentScheduler`, `maxOpsBeforeYield`,
  and `pollUnsafe()`.
- **Scheduler fairness knobs** (`Scheduler.ts:269–299`): `Scheduler.MaxOpsBeforeYield`
  (default 2048 ops before a cooperative yield — lower it to make CPU-bound fibers yield more
  often) and `Scheduler.PreventSchedulerYield` (the footgun that lets a fiber monopolize the
  thread; worth grepping for when hunting a hog).
- **Fiber registries you already own:** `FiberSet` / `FiberMap` / `FiberHandle` (core modules)
  track forked fibers with lifecycle; their sizes are trivially exported as gauges, giving
  per-subsystem fiber counts rather than the global `child_fibers_active`.
- **DevTools** (section 4, Path D) streams live spans and metric snapshots, which in practice is
  the fastest "what is running right now" view during development.

For "which fiber hogs the event loop" specifically, the practical v4 recipe is:
`enableRuntimeMetricsLayer` + an event-loop-lag gauge to see *that* it happens, and span
durations (SQLite tracer or OTLP) to see *where* — there is no built-in per-fiber CPU profiler,
and long-running synchronous work between yields shows up as lag correlated with whichever spans
are open.

## Sources

- `pnpm-workspace.yaml` — `effect` catalog pinned at `4.0.0-rc.112`.
- `.repos/effect/packages/effect/src/Effect.ts:8318` (`withSpan`), `:13605` (`fn` + span
  options), `:7994–8235` (annotate/link/make span), `:13704–13863` (log levels), `:13944`
  (`annotateLogs`), `:14061` (`withLogSpan`), `:4723` (`timed`).
- `.repos/effect/packages/effect/src/Tracer.ts:29` (Tracer interface), `:246–276`
  (`SpanOptions`), `:372` (Span interface), `:455` (`make`), `:563–592` (trace levels).
- `.repos/effect/packages/effect/src/Metric.ts:2091–2531` (constructors incl. `timer`),
  `:2591` (`value`), `:2938` (`snapshot`), `:2997` (`dump`), `:3065` (`snapshotUnsafe`),
  `:1640` (`MetricRegistry`), `:3214–3480` (fiber runtime metrics).
- `.repos/effect/packages/effect/src/Logger.ts:471` (`make`), `:594` (`formatStructured`),
  `:702` (`batched`), `:914` (`layer`), `:1004` (`toFile`);
  `internal/effect.ts:6267, 6634` (default logger set, `tracerLogger` span events).
- `.repos/effect/packages/effect/src/References.ts:349, 391, 547` (`MinimumLogLevel`,
  `TracerEnabled`, `TracerTimingEnabled`).
- `.repos/effect/packages/effect/src/Scheduler.ts:269, 295` (`MaxOpsBeforeYield`,
  `PreventSchedulerYield`).
- `.repos/effect/packages/effect/src/unstable/observability/Otlp.ts:35, 93`,
  `PrometheusMetrics.ts:103, 184`, and the `OtlpTracer`/`OtlpMetrics`/`OtlpLogger` modules.
- `.repos/effect/packages/effect/src/unstable/devtools/DevTools.ts:65`,
  `DevToolsClient.ts:52–110`, `DevToolsSchema.ts:466`.
- `.repos/effect/packages/opentelemetry/src/NodeSdk.ts:35–40, 109, 162`.
- `.repos/effect/ai-docs/src/08_observability/index.md` — Otlp-vs-NodeSdk guidance.
- Workspace: `apps/cli/src/telemetry.ts`, `apps/cli/src/commands.ts:296`,
  `apps/desktop/src/main/logger.ts`, `apps/desktop/src/main/engine-supervisor.ts:164–211`,
  `packages/engine/src/scheduler.ts:30–39`, `packages/engine/src/reconcile.ts:36, 283`,
  `packages/engine/src/recovery.ts:35`, `packages/engine/src/executor.ts:1586`,
  `docs/agent-patterns/effect-observability.md`.
