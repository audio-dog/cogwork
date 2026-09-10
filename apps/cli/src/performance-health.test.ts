import { DatabaseSync } from "node:sqlite";
import { PerformanceMetrics } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { readPerformanceHealthSnapshot } from "./performance-health";

const metricNames = PerformanceMetrics.processHealthMetricNames;

const writeHealthFixture = (storePath: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new DatabaseSync(storePath)),
    (database) =>
      Effect.sync(() => {
        database.exec(`CREATE TABLE metrics (
          timestamp INTEGER NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          attributes TEXT NOT NULL,
          state TEXT NOT NULL
        )`);
        const insert = database.prepare(
          "INSERT INTO metrics (timestamp, name, type, attributes, state) VALUES (?, ?, ?, ?, ?)",
        );
        const rows = [
          [metricNames.sampledAtMillis, "daemon", 9_000],
          [metricNames.heapUsedBytes, "daemon", 800],
          [metricNames.heapLimitBytes, "daemon", 1_000],
          [metricNames.eventLoopDelayP99Millis, "daemon", 125],
          [metricNames.sampledAtMillis, "renderer", 9_500],
          [metricNames.heapUsedBytes, "renderer", 700],
          [metricNames.heapLimitBytes, "renderer", 1_000],
        ] as const;
        rows.forEach(([name, process, value]) => {
          insert.run(10_000, name, "Gauge", JSON.stringify({ process }), JSON.stringify({ value }));
        });
      }),
    (database) => Effect.sync(() => database.close()),
  );

it.effect("reads one persisted telemetry window", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-performance-health-" });
    const storePath = path.join(root, "telemetry.db");
    yield* writeHealthFixture(storePath);

    const snapshot = yield* readPerformanceHealthSnapshot({ enabled: true, storePath });

    assert.deepStrictEqual(snapshot, {
      sampledAtMillis: snapshot.sampledAtMillis,
      daemon: {
        sampledAtMillis: 9_000,
        heapUsedBytes: 800,
        heapLimitBytes: 1_000,
        eventLoopDelayP99Millis: 125,
      },
      renderer: {
        sampledAtMillis: 9_500,
        heapUsedBytes: 700,
        heapLimitBytes: 1_000,
      },
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not read or create telemetry when collection is disabled", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-performance-health-disabled-" });
    const storePath = path.join(root, "telemetry.db");

    const snapshot = yield* readPerformanceHealthSnapshot({ enabled: false, storePath });

    assert.isUndefined(snapshot.daemon);
    assert.isUndefined(snapshot.renderer);
    assert.isFalse(yield* fs.exists(storePath));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fails when telemetry is unreadable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-performance-health-unreadable-" });
    const storePath = path.join(root, "missing", "telemetry.db");

    const error = yield* Effect.flip(readPerformanceHealthSnapshot({ enabled: true, storePath }));

    assert.strictEqual(error._tag, "UnknownError");
  }).pipe(Effect.provide(NodeServices.layer)),
);
