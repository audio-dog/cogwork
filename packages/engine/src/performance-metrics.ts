import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

import {
  type ProcessHealthSample,
  ProcessHealthSample as ProcessHealthSampleSchema,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";

export const processHealthMetricNames = {
  sampledAtMillis: "cogwork_process_health_sample_timestamp_milliseconds",
  heapUsedBytes: "cogwork_process_heap_used_bytes",
  heapLimitBytes: "cogwork_process_heap_limit_bytes",
  eventLoopDelayP99Millis: "cogwork_process_event_loop_delay_p99_milliseconds",
} as const;

export const processHealthMetrics = {
  sampleTimestampMillis: Metric.gauge(processHealthMetricNames.sampledAtMillis, {
    description: "Source timestamp of the latest health sample from a Cogwork process.",
  }),
  heapUsedBytes: Metric.gauge(processHealthMetricNames.heapUsedBytes, {
    description: "Current JavaScript heap bytes used by a Cogwork process.",
  }),
  heapLimitBytes: Metric.gauge(processHealthMetricNames.heapLimitBytes, {
    description: "Current JavaScript heap limit for a Cogwork process.",
  }),
  heapHeadroomBytes: Metric.gauge("cogwork_process_heap_headroom_bytes", {
    description: "Current JavaScript heap bytes available before the process heap limit.",
  }),
  privateBytes: Metric.gauge("cogwork_process_private_bytes", {
    description: "Current private memory bytes held by a Cogwork process.",
  }),
  eventLoopDelayP99Millis: Metric.gauge(processHealthMetricNames.eventLoopDelayP99Millis, {
    description: "Event-loop delay p99 during the latest process health window.",
  }),
  eventLoopUtilization: Metric.gauge("cogwork_process_event_loop_utilization_ratio", {
    description: "Event-loop utilization during the latest process health window.",
  }),
  mainIpcFramesPerSecond: Metric.gauge("cogwork_main_ipc_frames_forwarded_per_second", {
    description: "RPC frames forwarded by Electron main during the latest health window.",
  }),
  rendererProtocolInboxDepth: Metric.gauge("cogwork_renderer_protocol_inbox_depth", {
    description: "Frames waiting in the renderer protocol inbox.",
  }),
  rendererEventsAppliedPerSecond: Metric.gauge("cogwork_renderer_events_applied_per_second", {
    description: "Daemon events applied by the renderer during the latest health window.",
  }),
} as const;

const updateOptional = <State>(metric: Metric.Metric<number, State>, value: number | undefined) =>
  value === undefined ? Effect.void : Metric.update(metric, value);

const forProcess = <State>(metric: Metric.Metric<number, State>, process: ProcessHealthSample["process"]) =>
  Metric.withAttributes(metric, { process });

const updateForProcess = <State>(
  metric: Metric.Metric<number, State>,
  sample: ProcessHealthSample,
  value: number | undefined,
) => updateOptional(forProcess(metric, sample.process), value);

const updateMainIpcRate = (
  sample: ProcessHealthSample,
  direction: "to-renderer" | "to-daemon",
  value: number | undefined,
) =>
  updateOptional(
    Metric.withAttributes(processHealthMetrics.mainIpcFramesPerSecond, {
      process: sample.process,
      direction,
    }),
    value,
  );

const heapHeadroom = (sample: ProcessHealthSample) => {
  if (sample.heapUsedBytes === undefined) return undefined;
  if (sample.heapLimitBytes === undefined) return undefined;
  return Math.max(0, sample.heapLimitBytes - sample.heapUsedBytes);
};

const processMemoryUpdates = (sample: ProcessHealthSample) => [
  updateForProcess(processHealthMetrics.sampleTimestampMillis, sample, sample.sampledAtMillis),
  updateForProcess(processHealthMetrics.heapUsedBytes, sample, sample.heapUsedBytes),
  updateForProcess(processHealthMetrics.heapLimitBytes, sample, sample.heapLimitBytes),
  updateForProcess(processHealthMetrics.heapHeadroomBytes, sample, heapHeadroom(sample)),
  updateForProcess(processHealthMetrics.privateBytes, sample, sample.privateBytes),
];

const eventLoopUpdates = (sample: Extract<ProcessHealthSample, { readonly process: "daemon" | "main" }>) => [
  updateForProcess(processHealthMetrics.eventLoopDelayP99Millis, sample, sample.eventLoopDelayP99Millis),
  updateForProcess(processHealthMetrics.eventLoopUtilization, sample, sample.eventLoopUtilization),
];

const processHealthUpdates = (sample: ProcessHealthSample) =>
  ProcessHealthSampleSchema.match(sample, {
    daemon: (daemon) => [...processMemoryUpdates(daemon), ...eventLoopUpdates(daemon)],
    main: (main) => [
      ...processMemoryUpdates(main),
      ...eventLoopUpdates(main),
      updateMainIpcRate(main, "to-renderer", main.ipcFramesToRendererPerSecond),
      updateMainIpcRate(main, "to-daemon", main.ipcFramesToDaemonPerSecond),
    ],
    renderer: (renderer) => [
      ...processMemoryUpdates(renderer),
      updateForProcess(
        processHealthMetrics.rendererProtocolInboxDepth,
        renderer,
        renderer.protocolInboxDepth,
      ),
      updateForProcess(
        processHealthMetrics.rendererEventsAppliedPerSecond,
        renderer,
        renderer.eventsAppliedPerSecond,
      ),
    ],
  });

export const recordProcessHealth = Effect.fn("PerformanceMetrics.recordProcessHealth")(function* (
  sample: ProcessHealthSample,
) {
  yield* Effect.all(processHealthUpdates(sample), { discard: true });
});

const nanosecondsToMillis = (nanoseconds: number) =>
  Number.isFinite(nanoseconds) ? nanoseconds / 1_000_000 : 0;

const readDaemonProcessHealth = (
  delay: ReturnType<typeof monitorEventLoopDelay>,
  previousElu: Ref.Ref<ReturnType<typeof performance.eventLoopUtilization>>,
) =>
  Effect.gen(function* () {
    const sampledAtMillis = yield* Clock.currentTimeMillis;
    const previous = yield* Ref.get(previousElu);
    const current = performance.eventLoopUtilization();
    const utilization = performance.eventLoopUtilization(current, previous).utilization;
    const heap = getHeapStatistics();
    const heapUsedBytes = process.memoryUsage().heapUsed;
    yield* Ref.set(previousElu, current);
    yield* recordProcessHealth({
      process: "daemon",
      sampledAtMillis,
      heapUsedBytes,
      heapLimitBytes: heap.heap_size_limit,
      eventLoopDelayP99Millis: nanosecondsToMillis(delay.percentile(99)),
      eventLoopUtilization: Number.isFinite(utilization) ? utilization : 0,
    });
    yield* Effect.sync(() => delay.reset());
  });

export const reportDaemonProcessHealth = Effect.scoped(
  Effect.gen(function* () {
    const delay = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const nextDelay = monitorEventLoopDelay({ resolution: 20 });
        nextDelay.enable();
        return nextDelay;
      }),
      (currentDelay) => Effect.sync(() => currentDelay.disable()),
    );
    const previousElu = yield* Ref.make(performance.eventLoopUtilization());
    yield* readDaemonProcessHealth(delay, previousElu).pipe(Effect.repeat(Schedule.spaced("5 seconds")));
  }).pipe(Effect.provideService(References.TracerEnabled, false)),
);
