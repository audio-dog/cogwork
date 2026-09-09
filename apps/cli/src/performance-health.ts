import { DatabaseSync } from "node:sqlite";
import type { PerformanceRegressionSensor } from "@cogwork/engine";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

interface PerformanceHealthOptions {
  readonly enabled: boolean;
  readonly storePath: string;
}

const healthMetricNames = {
  sampledAtMillis: "cogwork_process_health_sample_timestamp_milliseconds",
  heapUsedBytes: "cogwork_process_heap_used_bytes",
  heapLimitBytes: "cogwork_process_heap_limit_bytes",
  eventLoopDelayP99Millis: "cogwork_process_event_loop_delay_p99_milliseconds",
} as const;
const healthMetricNameList = Object.values(healthMetricNames);

const PersistedHealthMetric = Schema.Struct({
  timestamp: Schema.Finite,
  name: Schema.String,
  process: Schema.Literals(["daemon", "renderer"]),
  value: Schema.Finite,
});
type PersistedHealthMetric = typeof PersistedHealthMetric.Type;

const decodePersistedHealthMetric = Schema.decodeUnknownOption(PersistedHealthMetric);

const readLatestRows = (storePath: string) =>
  Effect.acquireUseRelease(
    Effect.try(() => new DatabaseSync(storePath, { readOnly: true })),
    (database) =>
      Effect.try(() =>
        database
          .prepare(
            `SELECT timestamp,
                    name,
                    json_extract(attributes, '$.process') AS process,
                    json_extract(state, '$.value') AS value
             FROM metrics
             WHERE timestamp = (SELECT MAX(timestamp) FROM metrics)
               AND name IN (${healthMetricNameList.map(() => "?").join(", ")})`,
          )
          .all(...healthMetricNameList)
          .flatMap((row) => Option.toArray(decodePersistedHealthMetric(row))),
      ),
    (database) => Effect.sync(() => database.close()),
  );

const metricValue = (
  rows: ReadonlyArray<PersistedHealthMetric>,
  process: "daemon" | "renderer",
  name: string,
) => rows.find((row) => row.process === process && row.name === name)?.value;

const processReading = (rows: ReadonlyArray<PersistedHealthMetric>, process: "daemon" | "renderer") => {
  const sampledAtMillis = metricValue(rows, process, healthMetricNames.sampledAtMillis);
  const heapUsedBytes = metricValue(rows, process, healthMetricNames.heapUsedBytes);
  const heapLimitBytes = metricValue(rows, process, healthMetricNames.heapLimitBytes);
  if (sampledAtMillis === undefined || heapUsedBytes === undefined || heapLimitBytes === undefined) {
    return undefined;
  }
  const eventLoopDelayP99Millis = metricValue(rows, process, healthMetricNames.eventLoopDelayP99Millis);
  const reading: NonNullable<PerformanceRegressionSensor.PerformanceHealthSnapshot["daemon"]> = {
    sampledAtMillis,
    heapUsedBytes,
    heapLimitBytes,
    ...(process === "daemon" && eventLoopDelayP99Millis !== undefined ? { eventLoopDelayP99Millis } : {}),
  };
  return reading;
};

const snapshotFromRows = (rows: ReadonlyArray<PersistedHealthMetric>, fallbackTimestamp: number) => {
  const daemon = processReading(rows, "daemon");
  const renderer = processReading(rows, "renderer");
  return {
    sampledAtMillis: rows.at(0)?.timestamp ?? fallbackTimestamp,
    ...(daemon ? { daemon } : {}),
    ...(renderer ? { renderer } : {}),
  } satisfies PerformanceRegressionSensor.PerformanceHealthSnapshot;
};

export const readPerformanceHealthSnapshot = Effect.fn("PerformanceHealth.readSnapshot")(function* (
  options: PerformanceHealthOptions,
) {
  const now = yield* Clock.currentTimeMillis;
  if (!options.enabled) return snapshotFromRows([], now);
  return yield* readLatestRows(options.storePath).pipe(
    Effect.map((rows) => snapshotFromRows(rows, now)),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("performance health snapshot read failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.map(() => snapshotFromRows([], now)),
          ),
    ),
  );
});
