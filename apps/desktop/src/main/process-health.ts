import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import type { MainProcessHealthSample } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";

import { kibibytesToBytes, ratePerSecond } from "../shared/process-health";

interface FrameCounts {
  readonly toRenderer: number;
  readonly toDaemon: number;
}

interface FrameBaseline extends FrameCounts {
  readonly sampledAtMillis: number;
}

const increment = (counts: MutableRef.MutableRef<FrameCounts>, key: keyof FrameCounts) =>
  MutableRef.update(counts, (current) => ({ ...current, [key]: current[key] + 1 }));

const finite = (value: number) => (Number.isFinite(value) ? value : 0);

export const makeMainProcessHealth = () => {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  const counts = MutableRef.make<FrameCounts>({ toRenderer: 0, toDaemon: 0 });
  const previousElu = MutableRef.make(performance.eventLoopUtilization());
  const baseline = MutableRef.make<FrameBaseline>({
    sampledAtMillis: Date.now(),
    toRenderer: 0,
    toDaemon: 0,
  });
  delay.enable();

  return {
    recordToRenderer: () => increment(counts, "toRenderer"),
    recordToDaemon: () => increment(counts, "toDaemon"),
    sample: Effect.gen(function* () {
      const sampledAtMillis = Date.now();
      const currentCounts = MutableRef.get(counts);
      const previousCounts = MutableRef.getAndSet(baseline, { sampledAtMillis, ...currentCounts });
      const elapsedMillis = sampledAtMillis - previousCounts.sampledAtMillis;
      const currentElu = performance.eventLoopUtilization();
      const utilization = performance.eventLoopUtilization(currentElu, MutableRef.get(previousElu));
      const heap = process.getHeapStatistics();
      const memory = yield* Effect.tryPromise(() => process.getProcessMemoryInfo());
      MutableRef.set(previousElu, currentElu);
      const health = {
        process: "main",
        sampledAtMillis,
        heapUsedBytes: kibibytesToBytes(heap.usedHeapSize),
        heapLimitBytes: kibibytesToBytes(heap.heapSizeLimit),
        privateBytes: kibibytesToBytes(memory.private),
        eventLoopDelayP99Millis: finite(delay.percentile(99)) / 1_000_000,
        eventLoopUtilization: finite(utilization.utilization),
        ipcFramesToRendererPerSecond: ratePerSecond(
          previousCounts.toRenderer,
          currentCounts.toRenderer,
          elapsedMillis,
        ),
        ipcFramesToDaemonPerSecond: ratePerSecond(
          previousCounts.toDaemon,
          currentCounts.toDaemon,
          elapsedMillis,
        ),
      } satisfies MainProcessHealthSample;
      delay.reset();
      return health;
    }),
    close: Effect.sync(() => delay.disable()),
  } as const;
};
