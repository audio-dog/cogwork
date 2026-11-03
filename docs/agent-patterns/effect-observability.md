# Effect observability

Use this reference when adding logs, span attributes, metrics, or telemetry wiring. It covers correlation and measurement on top of the existing `Effect.fn` span discipline, not span naming, retry policy, or fiber supervision.

## Model

Every service method already runs inside a named span (`Effect.fn("Service.method")`). Observability work is what rides on that structure.

- Correlation fields are annotated once at the workflow root and inherited by everything downstream. Individual log calls never re-pass them.
- Operational counts and levels are metrics, not log lines. A log line that exists only to be grepped for a count is a missing counter.
- Outcomes come from `Exit`, and interruption is its own outcome. A drain must not inflate a failure rate.
- Telemetry is wired in one config-gated layer at the application edge, provided last so every span, metric, and log the app creates is exported.

## Choose the smallest operator

| Need | Prefer |
| --- | --- |
| Attach fields to every log line and span in a region | `Effect.annotateLogs` + `Effect.annotateSpans` at the region's root |
| Attach computed fields to the span you are already in | `Effect.annotateCurrentSpan` |
| Static attributes on a service method's span | the options argument: `Effect.fn(name, { attributes })` |
| Count events or observe durations | module-scope `Metric.counter` / `Metric.timer`, updated with `Metric.update` |
| Per-call metric dimensions | `Metric.withAttributes` around the update |
| Silence tracing on a noisy periodic path | `Effect.provideService(References.TracerEnabled, false)` |
| Causally link separate root spans (retry attempts) | `Effect.withSpan(name, { root: true })` + `Effect.linkSpans` |

## Annotate the workflow root, not each log call

`Executor.runClaimed` is the house pattern: build the correlation object once, apply it to the whole run body at the tail of the pipe.

```ts
const correlation = {
  workspace: workspace.config.name,
  item: item.id,
  stage: item.stage,
  runId,
};
return yield* Effect.gen(function* () {
  // ... the entire run body ...
}).pipe(Effect.annotateLogs(correlation), Effect.annotateSpans(correlation));
```

The scheduler (`runJob`), the reconcile tick, and the recovery pass annotate their roots the same way. The shape to avoid is each log call rebuilding the same fields by hand:

```ts
// Avoid: the enclosing workflow already knows workspace and item
yield* Effect.logInfo("recovered stale claim", {
  workspace: workspace.config.name,
  item: item.id,
});
```

Hand-passing loses correlation wherever one call forgets a field, and the field names drift (`item` vs `workItem`). Instead, annotate once where the workflow acquires its identity — the recovery pass per item, the reconcile tick per workspace, the scheduler's `runJob` per candidate — and let body logs carry only what is new at that call site (`reason`, `attempts`, `exhausted`).

Annotations are not string prefixes: `Logger.formatStructured` carries them in a first-class `annotations` field, and the OTLP exporters forward span annotations as attributes.

## Measure with metrics, not grep

Counters and gauges written as log lines have three costs: no aggregation, no alerting, and silence when the log is conditional. The rate-limit cooldown is the sharp case — only the first failure into a window logs, so the total number of rate-limit hits is unobservable by design. The scheduler is the other: a tick that schedules nothing because the daily budget is exhausted emits nothing at all.

Define metrics as module-scope constants next to the service, every one with a description:

```ts
const rateLimitHits = Metric.counter("cogwork_reconcile_rate_limit_hits_total", {
  description: "Rate-limit responses observed while polling issue trackers.",
});
const runsInFlight = Metric.gauge("cogwork_scheduler_runs_in_flight", {
  description: "Runs currently executing across all workspaces.",
});
```

Update them unconditionally, next to the state change, with bounded attribute sets:

```ts
yield* Metric.update(Metric.withAttributes(rateLimitHits, [["scope", scope ?? "global"]]), 1);
```

`Metric.withAttributes` returns a new metric, so per-call dimensions compose with the module constant. Keep attribute values to short, low-cardinality strings — never an item id or a message.

## Outcomes come from Exit, and interruption is not a failure

When a metric or a span attribute records how an operation ended, derive it from the `Exit` and give interruption its own bucket:

```ts
const outcome = Exit.isSuccess(exit)
  ? "success"
  : Cause.hasInterruptsOnly(exit.cause)
    ? "interrupt"
    : "failure";
```

The interruption-is-not-a-crash rule belongs to the fiber-lifecycle pattern; this is its metrics application. The scheduler already makes the distinction for its crash log (`Effect.catchCauseIf((cause) => !Cause.hasInterruptsOnly(cause), ...)`); metrics must make the same one. Drain interrupts every in-flight run on purpose — a failure counter that includes them is wrong every time the daemon restarts.

## Silence noise deliberately

The reconcile worker runs on a timer. Tracing every quiet tick buries the traces that matter. Do not solve this by deleting spans or sampling; disable the tracer for the subtree and keep its metrics and logs:

```ts
pollWorkspace(workspace).pipe(
  Effect.provideService(References.TracerEnabled, false),
);
```

`References.MinimumLogLevel` is the same shape for log volume: provide it in a layer (`Layer.succeed(References.MinimumLogLevel, "Warn")`) rather than deleting log calls.

## One telemetry layer, provided last

`telemetryLayer(options)` in `apps/cli/src/telemetry.ts` is the one pipeline: it composes
`localTelemetryLayer(...)` with `otlpTelemetryLayer()`, where the OTLP half keeps the `Layer.unwrap`
shape — a config read choosing `NodeSdk.layerEmpty` when no endpoint is configured — and exports
traces, metrics (`metricReader`), and logs (`logRecordProcessor`). Extend that file rather than
wiring a second pipeline.

The alternative route is Effect's own exporters (`effect/unstable/observability`: `OtlpTracer`, `OtlpMetrics`, `OtlpLogger` plus `OtlpSerialization` and an `HttpClient`), which drops the `@opentelemetry/*` dependencies entirely. Moving is a deliberate decision, not a side effect of adding a metric; until then, everything goes through the NodeSdk layer.

Either way the rule from the ai-docs holds: provide the observability layer at the very end of composition, so every span the app creates is exported. And there is exactly one logging pipeline — a host process that cannot run Effect (see the process-edges pattern) forwards into it instead of growing a parallel logger whose lines never carry annotations.

## Cogwork conventions

- Keep `Effect.fn("Service.method")` on every service method. Add static span attributes with the options argument, not with an extra `Effect.withSpan` wrapper.
- Every workflow root annotates logs and spans once with the correlation object (`workspace`, `item`, `stage`, `runId` — whichever exist at that root). Body log calls add only call-site-specific fields.
- Metrics are module-scope constants next to the service that owns the state, named `cogwork_<area>_<subject>_<unit>`, each with a `description`. Updates sit next to the state change and run unconditionally, even when the neighboring log is suppressed.
- Outcome attributes derive from `Exit`; `interrupt` is its own outcome, never counted as `failure`.
- Noisy periodic effects disable the tracer via `References.TracerEnabled`; log volume is tuned via `References.MinimumLogLevel` in a layer, not by deleting calls.
- Services that settle or persist state (`run-ledger`, `harness`, `git` are silent today) emit one structured log per state transition an operator would ask about — no more.
- Telemetry wiring lives only in `apps/cli/src/telemetry.ts`, provided last. The desktop app has no telemetry layer yet; when it gets one, it follows the same shape.

## Sources

- `.repos/effect/packages/effect/src/Effect.ts`: `annotateLogs`, `annotateSpans`, `annotateCurrentSpan`, `linkSpans`, `withSpan` (`root` option), and `Effect.fn`'s span-options argument.
- `.repos/effect/packages/effect/src/Metric.ts`: `counter`, `gauge`, `timer`, `update`, `withAttributes`.
- `.repos/effect/packages/effect/src/References.ts`: `MinimumLogLevel`, `TracerEnabled`, `TracerTimingEnabled`.
- `.repos/effect/packages/effect/src/Logger.ts`: `formatStructured` carries `annotations` and `spans` as first-class fields.
- `.repos/effect/ai-docs/src/08_observability/10_logging.ts` and `20_otlp-tracing.ts`: annotate-at-the-pipe-tail, `References.MinimumLogLevel`, and the provide-observability-last rule.
- `.agents/skills/effect-ts/references/guide-observability.md`.
- `packages/engine/src/scheduler.ts`: the forked job's correlation annotation — the in-repo
  exemplar, with `worktree-maintenance.ts` annotating each Workspace the same way.
- `packages/engine/src/scheduler.ts`: metrics defined next to the suppressed logs
  (`budgetExhaustedTicks`) — the metrics-not-grep exemplar.
- `apps/cli/src/telemetry.ts`: the one telemetry pipeline (`localTelemetryLayer` +
  config-gated `otlpTelemetryLayer`).
- `.repos/t3code/apps/server/src/observability/Metrics.ts`, `Attributes.ts`, and `RpcInstrumentation.ts`: module-scope metrics, attribute compaction, `Exit`-derived outcomes, and `TracerEnabled` suppression.
- `.repos/t3code/packages/client-runtime/src/connection/supervisor.ts`: root span per retry attempt linked with `Effect.linkSpans`.
