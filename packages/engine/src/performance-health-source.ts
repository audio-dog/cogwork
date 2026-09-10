import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProcessHealthReading {
  readonly sampledAtMillis: number;
  readonly heapUsedBytes: number;
  readonly heapLimitBytes: number;
  readonly eventLoopDelayP99Millis?: number;
}

export interface PerformanceHealthSnapshot {
  readonly sampledAtMillis: number;
  readonly daemon?: ProcessHealthReading;
  readonly renderer?: ProcessHealthReading;
}

export interface PerformanceHealthSourceService {
  readonly snapshot: Effect.Effect<PerformanceHealthSnapshot, Cause.UnknownError>;
}

export class PerformanceHealthSource extends Context.Service<
  PerformanceHealthSource,
  PerformanceHealthSourceService
>()("@cogwork/engine/performance-health-source/PerformanceHealthSource") {}
