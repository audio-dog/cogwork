import { PerformanceMetrics } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { readPerformanceHealthSnapshot } from "./performance-health";
import { telemetryLayer } from "./telemetry";

it.effect("reads one persisted telemetry window", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-performance-health-" });
    const storePath = path.join(root, "telemetry.db");
    yield* Effect.all(
      [
        PerformanceMetrics.recordProcessHealth({
          process: "daemon",
          sampledAtMillis: 9_000,
          heapUsedBytes: 800,
          heapLimitBytes: 1_000,
          eventLoopDelayP99Millis: 125,
          eventLoopUtilization: 0.5,
        }),
        PerformanceMetrics.recordProcessHealth({
          process: "renderer",
          sampledAtMillis: 9_500,
          heapUsedBytes: 700,
          heapLimitBytes: 1_000,
        }),
      ],
      { discard: true },
    ).pipe(
      Effect.provide(
        telemetryLayer({
          storePath,
          snapshotInterval: "1 hour",
          maintenanceInterval: "1 hour",
        }).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
      ),
      Effect.scoped,
    );

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
