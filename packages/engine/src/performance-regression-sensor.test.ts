import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { IssueTrackerError } from "./issue-tracker";
import type { PerformanceHealthSnapshot } from "./performance-health-source";
import { type PerformanceIssueFilingResult, PerformanceIssueFingerprint } from "./performance-issue-filer";
import {
  make,
  makeEvidenceWriter,
  type PerformanceEvidenceSnapshot,
  PerformanceRegressionSensor,
} from "./performance-regression-sensor";

const decodeFingerprint = Schema.decodeSync(PerformanceIssueFingerprint);

const breached = (sampledAtMillis: number) =>
  ({
    sampledAtMillis,
    daemon: {
      sampledAtMillis,
      eventLoopDelayP99Millis: 125,
      heapUsedBytes: 800,
      heapLimitBytes: 1_000,
    },
    renderer: {
      sampledAtMillis,
      heapUsedBytes: 800,
      heapLimitBytes: 1_000,
    },
  }) satisfies PerformanceHealthSnapshot;

const healthy = (sampledAtMillis: number) =>
  ({
    sampledAtMillis,
    daemon: {
      sampledAtMillis,
      eventLoopDelayP99Millis: 20,
      heapUsedBytes: 100,
      heapLimitBytes: 1_000,
    },
    renderer: {
      sampledAtMillis,
      heapUsedBytes: 100,
      heapLimitBytes: 1_000,
    },
  }) satisfies PerformanceHealthSnapshot;

interface SensorProbeService {
  readonly submissions: Ref.Ref<ReadonlyArray<{ readonly fingerprint: string; readonly body: string }>>;
  readonly evidence: Ref.Ref<ReadonlyArray<string>>;
  readonly attempts: Ref.Ref<number>;
  readonly evidenceWrites: Ref.Ref<number>;
}

class SensorProbe extends Context.Service<SensorProbe, SensorProbeService>()(
  "@cogwork/engine/performance-regression-sensor.test/SensorProbe",
) {
  static readonly layer = Layer.effect(
    SensorProbe,
    Effect.all({
      submissions: Ref.make<ReadonlyArray<{ readonly fingerprint: string; readonly body: string }>>([]),
      evidence: Ref.make<ReadonlyArray<string>>([]),
      attempts: Ref.make(0),
      evidenceWrites: Ref.make(0),
    }),
  );
}

const sensorContext = () =>
  Effect.succeed({
    runsInFlight: 2,
    workspaceCount: 1,
    machineLoad: { cpuCount: 8, loadAverage: [1, 0.5, 0.25], freeMemoryBytes: 1_000 },
  });

const standardSensorLayer = () =>
  Layer.effect(
    PerformanceRegressionSensor,
    Effect.gen(function* () {
      const probe = yield* SensorProbe;
      return yield* make({
        appVersion: "0.0.1-test",
        submit: (input, _now) =>
          Ref.update(probe.submissions, (current) => [
            ...current,
            { fingerprint: input.fingerprint, body: input.body },
          ]).pipe(Effect.map(() => "filed")),
        writeEvidence: (snapshot) =>
          Ref.update(probe.evidence, (current) => [...current, snapshot.healthSignal.fingerprint]).pipe(
            Effect.map(() => `/tmp/${snapshot.healthSignal.fingerprint}.json`),
          ),
        context: sensorContext(),
      });
    }),
  ).pipe(Layer.provideMerge(SensorProbe.layer));

const retryingSensorLayer = () =>
  Layer.effect(
    PerformanceRegressionSensor,
    Effect.gen(function* () {
      const probe = yield* SensorProbe;
      return yield* make({
        appVersion: "0.0.1-test",
        submit: () =>
          Ref.updateAndGet(probe.attempts, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Effect.fail(
                    new IssueTrackerError({
                      reason: "unavailable",
                      message: "tracker unavailable",
                    }),
                  )
                : Effect.succeed<PerformanceIssueFilingResult>("filed"),
            ),
          ),
        writeEvidence: () =>
          Ref.updateAndGet(probe.evidenceWrites, (count) => count + 1).pipe(
            Effect.map((count) => `/tmp/evidence-${count}.json`),
          ),
        context: sensorContext(),
      });
    }),
  ).pipe(Layer.provideMerge(SensorProbe.layer));

const permanentFailureSensorLayer = () =>
  Layer.effect(
    PerformanceRegressionSensor,
    Effect.gen(function* () {
      const probe = yield* SensorProbe;
      return yield* make({
        appVersion: "0.0.1-test",
        submit: () =>
          Ref.update(probe.attempts, (count) => count + 1).pipe(
            Effect.andThen(
              new IssueTrackerError({
                reason: "unavailable",
                retryable: false,
                message: "target is not configured",
              }),
            ),
          ),
        writeEvidence: () =>
          Ref.updateAndGet(probe.evidenceWrites, (count) => count + 1).pipe(
            Effect.map((count) => `/tmp/evidence-${count}.json`),
          ),
        context: sensorContext(),
      });
    }),
  ).pipe(Layer.provideMerge(SensorProbe.layer));

describe("performance regression sensor", () => {
  it.effect("files only on the transition into alarm", () =>
    Effect.gen(function* () {
      const sensor = yield* PerformanceRegressionSensor;
      const probe = yield* SensorProbe;

      yield* sensor.observe(breached(10_000));
      yield* sensor.observe(breached(20_000));
      assert.strictEqual((yield* Ref.get(probe.submissions)).length, 0);

      yield* sensor.observe(breached(30_000));
      yield* sensor.observe(breached(40_000));

      const filed = yield* Ref.get(probe.submissions);
      assert.deepStrictEqual(
        filed.map(({ fingerprint }) => fingerprint),
        ["daemon.event-loop-delay-p99.above", "daemon.heap-headroom.below", "renderer.heap-headroom.below"],
      );
      assert.strictEqual((yield* Ref.get(probe.evidence)).length, 3);
      assert.include(filed[0]?.body ?? "", "Observed: 125 ms");
      assert.include(filed[0]?.body ?? "", "Runs in flight: 2");
      assert.include(filed[0]?.body ?? "", "Evidence: /tmp/daemon.event-loop-delay-p99.above.json");
    }).pipe(Effect.provide(standardSensorLayer())),
  );

  it.effect("re-arms after recovery", () =>
    Effect.gen(function* () {
      const sensor = yield* PerformanceRegressionSensor;
      const probe = yield* SensorProbe;

      yield* sensor.observe(breached(10_000));
      yield* sensor.observe(breached(20_000));
      yield* sensor.observe(breached(30_000));
      yield* sensor.observe(healthy(40_000));
      yield* sensor.observe(breached(50_000));
      yield* sensor.observe(breached(60_000));
      yield* sensor.observe(breached(70_000));

      assert.strictEqual((yield* Ref.get(probe.submissions)).length, 6);
    }).pipe(Effect.provide(standardSensorLayer())),
  );

  it.effect("ignores repeated telemetry snapshots", () =>
    Effect.gen(function* () {
      const sensor = yield* PerformanceRegressionSensor;
      const probe = yield* SensorProbe;

      yield* sensor.observe(breached(10_000));
      yield* sensor.observe(breached(10_000));
      yield* sensor.observe(breached(10_000));

      assert.strictEqual((yield* Ref.get(probe.submissions)).length, 0);
    }).pipe(Effect.provide(standardSensorLayer())),
  );

  it.effect("resets the breach count after a missing window", () =>
    Effect.gen(function* () {
      const sensor = yield* PerformanceRegressionSensor;
      const probe = yield* SensorProbe;

      yield* sensor.observe(breached(10_000));
      yield* sensor.observe(breached(30_000));
      yield* sensor.observe(breached(40_000));

      assert.strictEqual((yield* Ref.get(probe.submissions)).length, 0);

      yield* sensor.observe(breached(50_000));

      assert.strictEqual((yield* Ref.get(probe.submissions)).length, 3);
    }).pipe(Effect.provide(standardSensorLayer())),
  );

  it.effect("reuses evidence while a failed filing is retried", () =>
    Effect.gen(function* () {
      const sensor = yield* PerformanceRegressionSensor;
      const probe = yield* SensorProbe;
      const eventLoopBreach = (sampledAtMillis: number) =>
        ({
          sampledAtMillis,
          daemon: {
            sampledAtMillis,
            eventLoopDelayP99Millis: 125,
            heapUsedBytes: 100,
            heapLimitBytes: 1_000,
          },
        }) satisfies PerformanceHealthSnapshot;

      yield* sensor.observe(eventLoopBreach(10_000));
      yield* sensor.observe(eventLoopBreach(20_000));
      yield* Effect.flip(sensor.observe(eventLoopBreach(30_000)));
      yield* sensor.observe(eventLoopBreach(40_000));

      assert.strictEqual(yield* Ref.get(probe.attempts), 2);
      assert.strictEqual(yield* Ref.get(probe.evidenceWrites), 1);
    }).pipe(Effect.provide(retryingSensorLayer())),
  );

  it.effect("files a pending transition after the signal recovers", () =>
    Effect.gen(function* () {
      const sensor = yield* PerformanceRegressionSensor;
      const probe = yield* SensorProbe;

      yield* sensor.observe(breached(10_000));
      yield* sensor.observe(breached(20_000));
      yield* Effect.flip(sensor.observe(breached(30_000)));
      yield* sensor.observe(healthy(40_000));
      yield* sensor.observe(breached(50_000));
      yield* sensor.observe(breached(60_000));
      yield* sensor.observe(breached(70_000));

      assert.strictEqual(yield* Ref.get(probe.attempts), 7);
      assert.strictEqual(yield* Ref.get(probe.evidenceWrites), 6);
    }).pipe(Effect.provide(retryingSensorLayer())),
  );

  it.effect("does not retry a permanent filing rejection", () =>
    Effect.gen(function* () {
      const sensor = yield* PerformanceRegressionSensor;
      const probe = yield* SensorProbe;

      yield* sensor.observe(breached(10_000));
      yield* sensor.observe(breached(20_000));
      yield* sensor.observe(breached(30_000));
      yield* sensor.observe(breached(40_000));

      assert.strictEqual(yield* Ref.get(probe.attempts), 3);
      assert.strictEqual(yield* Ref.get(probe.evidenceWrites), 3);
    }).pipe(Effect.provide(permanentFailureSensorLayer())),
  );

  it.effect("writes the evidence snapshot under its fingerprint", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-performance-evidence-" });
      const write = yield* makeEvidenceWriter(root);
      const snapshot: PerformanceEvidenceSnapshot = {
        capturedAtMillis: 30_000,
        healthSignal: {
          fingerprint: decodeFingerprint("daemon.event-loop-delay-p99.above"),
          title: "Daemon event-loop delay p99 exceeded 100 ms",
          display: "daemon event-loop delay p99 above threshold",
          recovery: "daemon event-loop delay p99 is at or below the threshold",
          observed: 125,
          threshold: 100,
          unit: "ms",
          direction: "above",
          sampledAtMillis: 30_000,
        },
        windowMillis: 10_000,
        consecutiveBreaches: 3,
        context: {
          appVersion: "test",
          runsInFlight: 2,
          workspaceCount: 1,
          machineLoad: { cpuCount: 8, loadAverage: [1, 0.5, 0.25], freeMemoryBytes: 1_000 },
        },
      };

      const evidencePath = yield* write(snapshot);

      assert.strictEqual(evidencePath, path.join(root, "daemon.event-loop-delay-p99.above", "30000.json"));
      const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        yield* fs.readFileString(evidencePath),
      );
      assert.deepStrictEqual(decoded, snapshot);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
