import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { IssueTrackerError } from "./issue-tracker";
import type { PerformanceIssueFilingResult } from "./performance-issue-filer";
import {
  make,
  makeEvidenceWriter,
  type PerformanceEvidenceSnapshot,
  type PerformanceHealthSnapshot,
} from "./performance-regression-sensor";

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

const fixture = () =>
  Effect.gen(function* () {
    const submissions = yield* Ref.make<
      ReadonlyArray<{ readonly fingerprint: string; readonly body: string }>
    >([]);
    const evidence = yield* Ref.make<ReadonlyArray<string>>([]);
    const sensor = yield* make({
      appVersion: "0.0.1-test",
      submit: (input, _now) =>
        Ref.update(submissions, (current) => [
          ...current,
          { fingerprint: input.fingerprint, body: input.body },
        ]).pipe(Effect.map(() => "filed")),
      writeEvidence: (snapshot) =>
        Ref.update(evidence, (current) => [...current, snapshot.healthSignal.fingerprint]).pipe(
          Effect.map(() => `/tmp/${snapshot.healthSignal.fingerprint}.json`),
        ),
      context: Effect.succeed({
        runsInFlight: 2,
        workspaceCount: 1,
        machineLoad: { cpuCount: 8, loadAverage: [1, 0.5, 0.25], freeMemoryBytes: 1_000 },
      }),
    });
    return { sensor, submissions, evidence };
  });

describe("performance regression sensor", () => {
  it.effect("files only on the transition into alarm", () =>
    Effect.gen(function* () {
      const { sensor, submissions, evidence } = yield* fixture();

      yield* sensor.observe(breached(10_000));
      yield* sensor.observe(breached(20_000));
      assert.strictEqual((yield* Ref.get(submissions)).length, 0);

      yield* sensor.observe(breached(30_000));
      yield* sensor.observe(breached(40_000));

      const filed = yield* Ref.get(submissions);
      assert.deepStrictEqual(
        filed.map(({ fingerprint }) => fingerprint),
        ["daemon.event-loop-delay-p99.above", "daemon.heap-headroom.below", "renderer.heap-headroom.below"],
      );
      assert.strictEqual((yield* Ref.get(evidence)).length, 3);
      assert.include(filed[0]?.body ?? "", "Observed: 125 ms");
      assert.include(filed[0]?.body ?? "", "Runs in flight: 2");
      assert.include(filed[0]?.body ?? "", "Evidence: /tmp/daemon.event-loop-delay-p99.above.json");
    }),
  );

  it.effect("re-arms after recovery", () =>
    Effect.gen(function* () {
      const { sensor, submissions } = yield* fixture();

      yield* sensor.observe(breached(10_000));
      yield* sensor.observe(breached(20_000));
      yield* sensor.observe(breached(30_000));
      yield* sensor.observe(healthy(40_000));
      yield* sensor.observe(breached(50_000));
      yield* sensor.observe(breached(60_000));
      yield* sensor.observe(breached(70_000));

      assert.strictEqual((yield* Ref.get(submissions)).length, 6);
    }),
  );

  it.effect("ignores repeated telemetry snapshots", () =>
    Effect.gen(function* () {
      const { sensor, submissions } = yield* fixture();

      yield* sensor.observe(breached(10_000));
      yield* sensor.observe(breached(10_000));
      yield* sensor.observe(breached(10_000));

      assert.strictEqual((yield* Ref.get(submissions)).length, 0);
    }),
  );

  it.effect("reuses evidence while a failed filing is retried", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const evidenceWrites = yield* Ref.make(0);
      const sensor = yield* make({
        appVersion: "0.0.1-test",
        submit: () =>
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Effect.fail(
                    new IssueTrackerError({
                      reason: "unavailable",
                      retryable: true,
                      message: "tracker unavailable",
                    }),
                  )
                : Effect.succeed<PerformanceIssueFilingResult>("filed"),
            ),
          ),
        writeEvidence: () =>
          Ref.updateAndGet(evidenceWrites, (count) => count + 1).pipe(
            Effect.map((count) => `/tmp/evidence-${count}.json`),
          ),
        context: Effect.succeed({
          runsInFlight: 0,
          workspaceCount: 1,
          machineLoad: { cpuCount: 8, loadAverage: [1, 0.5, 0.25], freeMemoryBytes: 1_000 },
        }),
      });
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

      assert.strictEqual(yield* Ref.get(attempts), 2);
      assert.strictEqual(yield* Ref.get(evidenceWrites), 1);
    }),
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
          fingerprint: "daemon.event-loop-delay-p99.above",
          title: "Daemon event-loop delay p99 exceeded 100 ms",
          display: "daemon event-loop delay p99 above threshold",
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
