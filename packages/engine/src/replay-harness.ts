import { type HarnessName, RunEvent as RunEventSchema, RunId } from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import type { ConfigError } from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  fullHarnessExecution,
  HarnessError,
  type HarnessExecution,
  type HarnessReadiness,
  type HarnessRunner,
} from "./harness";
import { decodeStoredRunEvent } from "./run-event-codec";

const replaySampleMinimum = 10;
const replaySampleMaximum = 1_000;
const replayHarnessExecution = {
  ...fullHarnessExecution,
  profiles: ["read-only"],
} satisfies HarnessExecution;
const positiveMillis = Schema.Finite.check(Schema.isGreaterThan(0));
const timedMillis = Schema.Array(positiveMillis).check(
  Schema.isBetweenLength(replaySampleMinimum, replaySampleMaximum),
);

export class ReplayFixture extends Schema.Class<ReplayFixture>("ReplayFixture")({
  version: Schema.Literal(1),
  sourceRunId: RunId,
  events: Schema.Array(RunEventSchema).check(Schema.isBetweenLength(1, 1_000_000)),
}) {}

export class ReplayCounts extends Schema.Class<ReplayCounts>("ReplayCounts")({
  eventsProcessed: Schema.Natural,
  sqliteInserts: Schema.Natural,
  ipcFrames: Schema.Natural,
  bytes: Schema.Natural,
  eventBusDrops: Schema.Natural,
}) {}

export class ReplaySample extends Schema.Class<ReplaySample>("ReplaySample")({
  counts: ReplayCounts,
  elapsedMillis: positiveMillis,
}) {}

export const ReplaySpeed = Schema.Literals(["1x", "2x", "4x", "6x", "8x", "unpaced"]);
export type ReplaySpeed = typeof ReplaySpeed.Type;

export class ReplayReport extends Schema.Class<ReplayReport>("ReplayReport")({
  version: Schema.Literal(1),
  fixture: Schema.String,
  fixtureDigest: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  concurrency: Schema.Int.check(Schema.isGreaterThan(0)),
  speed: ReplaySpeed,
  warmupMillis: timedMillis,
  samples: Schema.Array(ReplaySample).check(Schema.isBetweenLength(replaySampleMinimum, replaySampleMaximum)),
}) {}

export class ReplayComparisonError extends Schema.TaggedError<ReplayComparisonError>()(
  "ReplayComparisonError",
  { message: Schema.String },
) {}

const ReplayFixtureJson = Schema.fromJsonString(ReplayFixture);
const ReplayReportJson = Schema.fromJsonString(ReplayReport);

export const encodeReplayFixture = Schema.encodeEffect(ReplayFixtureJson);
export const decodeReplayFixture = Effect.fn("Replay.decodeFixture")(function* (input: unknown) {
  const fixture = yield* Schema.decodeUnknownEffect(ReplayFixtureJson)(input);
  yield* Effect.forEach(fixture.events, (event) => decodeStoredRunEvent(event.data), { discard: true });
  return fixture;
});
export const encodeReplayReport = Schema.encodeEffect(ReplayReportJson);
export const decodeReplayReport = Schema.decodeUnknownEffect(ReplayReportJson);

const replayDelayMillis = (fixture: ReplayFixture, index: number, speed: number) => {
  if (!Number.isFinite(speed)) return 0;

  const firstAtMillis = fixture.events[0]?.atMillis ?? 0;
  const currentAtMillis = fixture.events[index]?.atMillis ?? firstAtMillis;
  return Math.max(0, currentAtMillis - firstAtMillis) / speed;
};

const replayDelays = (fixture: ReplayFixture, speed: number) =>
  fixture.events.map((event, index) => ({
    event,
    delayMillis: replayDelayMillis(fixture, index, speed),
  }));

export const replayFixtureEvents = (fixture: ReplayFixture, speed: number) =>
  Stream.unwrap(
    Clock.currentTimeMillis.pipe(
      Effect.map((startedAtMillis) =>
        Stream.fromIterable(replayDelays(fixture, speed)).pipe(
          Stream.mapEffect(({ event, delayMillis }) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                Effect.sleep(`${Math.max(0, startedAtMillis + delayMillis - now)} millis`),
              ),
              Effect.andThen(decodeStoredRunEvent(event.data)),
            ),
          ),
        ),
      ),
    ),
  );

type ReplayCountName = "eventsProcessed" | "sqliteInserts" | "ipcFrames" | "bytes" | "eventBusDrops";

const replayCountNames: ReadonlyArray<ReplayCountName> = [
  "eventsProcessed",
  "sqliteInserts",
  "ipcFrames",
  "bytes",
  "eventBusDrops",
];

interface CountComparison {
  readonly base: number | null;
  readonly head: number | null;
  readonly status: "equal" | "changed" | "unstable";
}

export interface ReplayComparison {
  readonly counts: {
    readonly status: "equal" | "changed" | "unstable";
    readonly metrics: Record<ReplayCountName, CountComparison>;
  };
  readonly timings: {
    readonly status: "improvement" | "regression" | "inconclusive";
    readonly baseMedianMillis: number;
    readonly headMedianMillis: number;
    readonly medianRatio: number;
    readonly lowRatio: number;
    readonly highRatio: number;
  };
}

const sortNumbers = (values: ReadonlyArray<number>) => values.toSorted((left, right) => left - right);

const medianFromSorted = (sorted: ReadonlyArray<number>) => {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const median = (values: ReadonlyArray<number>) => medianFromSorted(sortNumbers(values));

const percentile = (values: ReadonlyArray<number>, probability: number) => {
  const sorted = sortNumbers(values);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower] ?? 0;
  if (lower === upper) return lowerValue;
  const weight = index - lower;
  return lowerValue * (1 - weight) + (sorted[upper] ?? lowerValue) * weight;
};

const randomUnitAt = (seed: number, offset: number) => {
  const state = seed + Math.imul(offset + 1, 0x6d2b79f5);
  const mixed = Math.imul(state ^ (state >>> 15), state | 1);
  const value = mixed ^ (mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61));
  return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
};

const bootstrapMedianLogRatio = (ratios: ReadonlyArray<number>) => {
  const iterations = 10_000;
  const logRatios = sortNumbers(ratios).map(Math.log);
  const samples = Array.from({ length: iterations }, (_, iteration) =>
    median(
      logRatios.map(
        (_, sample) =>
          logRatios[
            Math.floor(randomUnitAt(0x5eed1234, iteration * logRatios.length + sample) * logRatios.length)
          ] ?? 0,
      ),
    ),
  );
  return {
    medianRatio: Math.exp(median(logRatios)),
    lowRatio: Math.exp(percentile(samples, 0.025)),
    highRatio: Math.exp(percentile(samples, 0.975)),
  };
};

const countValues = (report: ReplayReport, name: ReplayCountName) =>
  report.samples.map((sample) => sample.counts[name]);

const countState = (report: ReplayReport, name: ReplayCountName) => {
  const values = countValues(report, name);
  return { value: values[0] ?? null, stable: new Set(values).size === 1 };
};

const compareCount = (base: ReplayReport, head: ReplayReport, name: ReplayCountName) => {
  const baseState = countState(base, name);
  const headState = countState(head, name);
  if (!baseState.stable || !headState.stable) {
    return { base: baseState.value, head: headState.value, status: "unstable" } satisfies CountComparison;
  }
  return {
    base: baseState.value,
    head: headState.value,
    status: baseState.value === headState.value ? "equal" : "changed",
  } satisfies CountComparison;
};

const countMetrics = (base: ReplayReport, head: ReplayReport) => ({
  eventsProcessed: compareCount(base, head, "eventsProcessed"),
  sqliteInserts: compareCount(base, head, "sqliteInserts"),
  ipcFrames: compareCount(base, head, "ipcFrames"),
  bytes: compareCount(base, head, "bytes"),
  eventBusDrops: compareCount(base, head, "eventBusDrops"),
});

const comparisonFailure = (message: string) => ReplayComparisonError.make({ message });

const validateReports = Effect.fn("Replay.validateReports")(function* (
  base: ReplayReport,
  head: ReplayReport,
) {
  if (base.samples.length !== head.samples.length) {
    return yield* comparisonFailure("replay reports require the same number of samples per side");
  }
  if (base.warmupMillis.length !== head.warmupMillis.length) {
    return yield* comparisonFailure("replay reports require the same number of warm-up runs per side");
  }
  if (base.fixture !== head.fixture) {
    return yield* comparisonFailure("replay reports must use the same fixture");
  }
  if (base.fixtureDigest !== head.fixtureDigest) {
    return yield* comparisonFailure("replay reports must use the same fixture digest");
  }
  if (base.concurrency !== head.concurrency) {
    return yield* comparisonFailure("replay reports must use the same concurrency");
  }
  if (base.speed !== head.speed) {
    return yield* comparisonFailure("replay reports must use the same speed");
  }
});

const timingStatus = (lowRatio: number, highRatio: number) => {
  if (highRatio < 0.98) return "improvement";
  if (lowRatio > 1.05) return "regression";
  return "inconclusive";
};

const countStatus = (comparisons: ReadonlyArray<CountComparison>) => {
  if (comparisons.some((comparison) => comparison.status === "unstable")) return "unstable";
  if (comparisons.some((comparison) => comparison.status === "changed")) return "changed";
  return "equal";
};

const elapsedMillis = (report: ReplayReport) => report.samples.map((sample) => sample.elapsedMillis);

const timingComparison = (base: ReplayReport, head: ReplayReport) => {
  const baseElapsed = elapsedMillis(base);
  const headElapsed = elapsedMillis(head);
  const ratios = baseElapsed.map((sample, index) => (headElapsed[index] ?? sample) / sample);
  const interval = bootstrapMedianLogRatio(ratios);
  return {
    status: timingStatus(interval.lowRatio, interval.highRatio),
    baseMedianMillis: median(baseElapsed),
    headMedianMillis: median(headElapsed),
    ...interval,
  } satisfies ReplayComparison["timings"];
};

export const compareReplayReports = Effect.fn("Replay.compareReports")(function* (
  base: ReplayReport,
  head: ReplayReport,
) {
  yield* validateReports(base, head);
  const metrics = countMetrics(base, head);
  const comparisons = Object.values(metrics);
  return {
    counts: { status: countStatus(comparisons), metrics },
    timings: timingComparison(base, head),
  } satisfies ReplayComparison;
});

export const formatReplayComparison = (comparison: ReplayComparison) => {
  const countLines = replayCountNames.map((name) => {
    const metric = comparison.counts.metrics[name];
    return `${name}: ${metric.base} -> ${metric.head} (${metric.status})`;
  });
  const timing = comparison.timings;
  return [
    `counts: ${comparison.counts.status}`,
    ...countLines,
    `timings: ${timing.status}`,
    `median-ms: ${timing.baseMedianMillis} -> ${timing.headMedianMillis}`,
    `median-ratio-95ci: ${timing.medianRatio.toFixed(3)} [${timing.lowRatio.toFixed(3)}, ${timing.highRatio.toFixed(3)}]`,
  ].join("\n");
};

const fixtureDeadline = "5 seconds";
const fixtureMaxBytes = 16 * 1024 * 1024;
const missingFixtureMessage = "Set COGWORK_REPLAY_FIXTURE to an exported replay fixture";

const fixtureFailure = (message: string, retryable = false) =>
  HarnessError.make({ reason: "launch", retryable, message });

const readReplayFixture = Effect.fn("ReplayHarness.readFixture")(function* (fixturePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(fixturePath).pipe(
    Effect.mapError(() => fixtureFailure(`replay fixture cannot be inspected: ${fixturePath}`)),
    Effect.timeout(fixtureDeadline),
    Effect.catchTag("TimeoutError", () =>
      fixtureFailure(`replay fixture inspect timed out after ${fixtureDeadline}: ${fixturePath}`, true),
    ),
  );
  if (info.size > fixtureMaxBytes) {
    return yield* fixtureFailure(`replay fixture exceeds ${fixtureMaxBytes} bytes: ${fixturePath}`);
  }
  const encoded = yield* fs.readFileString(fixturePath).pipe(
    Effect.mapError(() => fixtureFailure(`replay fixture could not be read: ${fixturePath}`)),
    Effect.timeout(fixtureDeadline),
    Effect.catchTag("TimeoutError", () =>
      fixtureFailure(`replay fixture read timed out after ${fixtureDeadline}: ${fixturePath}`, true),
    ),
  );
  return yield* decodeReplayFixture(encoded).pipe(
    Effect.mapError(() => fixtureFailure(`replay fixture could not be decoded: ${fixturePath}`)),
  );
});

const readinessBase = {
  installation: { status: "installed", version: "1" },
  compatibility: { status: "compatible", requirement: null },
  authentication: { mode: "host", status: "available", diagnostic: "No authentication required" },
} satisfies Pick<HarnessReadiness, "installation" | "compatibility" | "authentication">;

const ready = () =>
  ({
    ...readinessBase,
    operational: { status: "ready", retryable: false, diagnostic: "Replay fixture is ready" },
    diagnostics: [],
  }) satisfies HarnessReadiness;

const unavailable = (diagnostic: string, retryable = false) =>
  ({
    ...readinessBase,
    operational: { status: "unavailable", retryable, diagnostic },
    diagnostics: [diagnostic],
  }) satisfies HarnessReadiness;

export const replaySpeeds: ReadonlyArray<ReplaySpeed> = ["1x", "2x", "4x", "6x", "8x", "unpaced"];

const speedFrom = (selection: string | boolean | undefined) => {
  const namedSpeed = selection === "unpaced" ? Infinity : null;
  const parsed = namedSpeed ?? Number.parseInt(typeof selection === "string" ? selection : "1x", 10);
  const isValidSpeed = parsed === Infinity || (Number.isFinite(parsed) && parsed > 0);
  return isValidSpeed ? parsed : 1;
};

const configuredFixture = Effect.fn("ReplayHarness.configuredFixture")(function* (
  fixturePath: Effect.Effect<string | undefined, ConfigError>,
) {
  const path = yield* fixturePath.pipe(
    Effect.mapError((error) => fixtureFailure(`replay fixture configuration failed: ${String(error)}`)),
  );
  if (!path) return yield* fixtureFailure(missingFixtureMessage);
  return yield* readReplayFixture(path);
});

const invalidateFailedFixture =
  (invalidate: Effect.Effect<void>) => (exit: Exit.Exit<ReplayFixture, HarnessError>) => {
    if (Exit.isSuccess(exit)) return Effect.void;
    return invalidate;
  };

export const replayRunner = Effect.fn("ReplayHarness.runner")(function* (options: {
  readonly name: HarnessName;
  readonly fixturePath: Effect.Effect<string | undefined, ConfigError>;
}) {
  return yield* Effect.cachedInvalidateWithTTL(
    configuredFixture(options.fixturePath),
    Duration.infinity,
  ).pipe(
    Effect.map(
      ([fixture, invalidateFixture]) =>
        ({
          name: options.name,
          sessionKind: "owned-transcript",
          execution: replayHarnessExecution,
          capabilities: {
            authenticationModes: ["host"],
            session: { affinity: "portable", fork: false, humanAttach: false },
            structuredOutput: "native",
            policyFidelity: "exact",
            fileEventFidelity: "absent",
            usageQuality: "none",
            readinessDiagnostics: true,
            journal: false,
            takeover: false,
          },
          authentication: { mode: "host", reference: "fixture" },
          catalog: {
            models: [
              {
                value: "fixture",
                label: "Exported fixture",
                default: true,
                options: [
                  {
                    type: "select",
                    id: "speed",
                    label: "Speed",
                    values: replaySpeeds.map((speed) => ({ value: speed, label: speed })),
                    defaultValue: "1x",
                  },
                ],
              },
            ],
          },
          projectedMembers: [],
          planMiddleware: [],
          readiness: () =>
            fixture.pipe(
              Effect.onExit(invalidateFailedFixture(invalidateFixture)),
              Effect.match({
                onFailure: (error) => unavailable(error.message, error.retryable),
                onSuccess: ready,
              }),
            ),
          preflight: () =>
            fixture.pipe(Effect.onExit(invalidateFailedFixture(invalidateFixture)), Effect.asVoid),
          run: (request) =>
            Stream.unwrap(
              fixture.pipe(
                Effect.onExit(invalidateFailedFixture(invalidateFixture)),
                Effect.map((loadedFixture) =>
                  replayFixtureEvents(loadedFixture, speedFrom(request.plan.harness.options.speed)).pipe(
                    Stream.mapError(() => fixtureFailure("replay fixture contains an invalid event")),
                  ),
                ),
              ),
            ),
        }) satisfies HarnessRunner,
    ),
  );
});
