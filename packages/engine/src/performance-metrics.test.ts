import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import { processHealthMetrics, recordProcessHealth } from "./performance-metrics";

describe("process health metrics", () => {
  it.effect("records heap headroom and process-specific rates", () =>
    Effect.gen(function* () {
      yield* recordProcessHealth({
        process: "main",
        sampledAtMillis: 1_000,
        heapUsedBytes: 400,
        heapLimitBytes: 1_000,
        privateBytes: 800,
        eventLoopDelayP99Millis: 3.5,
        eventLoopUtilization: 0.25,
        ipcFramesToRendererPerSecond: 20,
        ipcFramesToDaemonPerSecond: 10,
      });
      yield* recordProcessHealth({
        process: "renderer",
        sampledAtMillis: 1_000,
        heapUsedBytes: 200,
        heapLimitBytes: 1_000,
        privateBytes: 500,
        protocolInboxDepth: 4,
        eventsAppliedPerSecond: 12,
      });

      const mainHeap = Metric.withAttributes(processHealthMetrics.heapHeadroomBytes, {
        process: "main",
      });
      const mainSampleTimestamp = Metric.withAttributes(processHealthMetrics.sampleTimestampMillis, {
        process: "main",
      });
      const rendererInbox = Metric.withAttributes(processHealthMetrics.rendererProtocolInboxDepth, {
        process: "renderer",
      });
      const toRenderer = Metric.withAttributes(processHealthMetrics.mainIpcFramesPerSecond, {
        process: "main",
        direction: "to-renderer",
      });

      assert.strictEqual((yield* Metric.value(mainHeap)).value, 600);
      assert.strictEqual((yield* Metric.value(mainSampleTimestamp)).value, 1_000);
      assert.strictEqual((yield* Metric.value(rendererInbox)).value, 4);
      assert.strictEqual((yield* Metric.value(toRenderer)).value, 20);
      assert.include(yield* Metric.dump, "cogwork_process_heap_headroom_bytes");
    }),
  );
});
