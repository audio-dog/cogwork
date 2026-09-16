import { availableParallelism, freemem, loadavg } from "node:os";
import { issueTrackerErrorIsPermanent } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Formatter from "effect/Formatter";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import type { IssueTrackerError } from "./issue-tracker";
import type { PerformanceHealthSnapshot, ProcessHealthReading } from "./performance-health-source";
import {
  PerformanceIssueFiler,
  type PerformanceIssueFilerService,
  type PerformanceIssueFingerprint,
  type PerformanceVerdict,
  performanceVerdictFingerprint,
} from "./performance-issue-filer";
import type { RegistryState } from "./projector";
import { WorkspaceRegistry } from "./registry";
import { Scheduler, type SchedulerState } from "./scheduler";

export interface MachineLoadSnapshot {
  readonly cpuCount: number;
  readonly loadAverage: ReadonlyArray<number>;
  readonly freeMemoryBytes: number;
}

export interface PerformanceEvidenceContext {
  readonly runsInFlight: number;
  readonly workspaceCount: number;
  readonly machineLoad: MachineLoadSnapshot;
}

interface HealthSignalReading {
  readonly signal: PerformanceVerdict["signal"];
  readonly subsystem: PerformanceVerdict["subsystem"];
  readonly observed: number;
  readonly threshold: number;
  readonly unit: "ms" | "%";
  readonly direction: "above" | "below";
  readonly sampledAtMillis: number;
}

export interface PerformanceEvidenceSnapshot {
  readonly capturedAtMillis: number;
  readonly healthSignal: HealthSignalReading;
  readonly windowMillis: number;
  readonly consecutiveBreaches: number;
  readonly context: PerformanceEvidenceContext & { readonly appVersion: string };
}

export interface PerformanceRegressionSensorDependencies {
  readonly appVersion: string;
  readonly submit: PerformanceIssueFilerService["submit"];
  readonly writeEvidence: (snapshot: PerformanceEvidenceSnapshot) => Effect.Effect<string, PlatformError>;
  readonly context: Effect.Effect<PerformanceEvidenceContext>;
}

export interface PerformanceRegressionSensorService {
  readonly observe: (
    snapshot: PerformanceHealthSnapshot,
  ) => Effect.Effect<void, IssueTrackerError | PlatformError>;
}

export class PerformanceRegressionSensor extends Context.Service<
  PerformanceRegressionSensor,
  PerformanceRegressionSensorService
>()("@cogwork/engine/performance-regression-sensor/PerformanceRegressionSensor") {}

interface HealthSignalState {
  readonly alarm: boolean;
  readonly breaches: number;
  readonly sampledAtMillis: number;
  readonly pending?: {
    readonly verdict: PerformanceVerdict;
    readonly retryAtMillis?: number;
  };
}

type PendingFiling = NonNullable<HealthSignalState["pending"]>;

const windowMillis = 10_000;
const dayMillis = 24 * 60 * 60 * 1_000;
const consecutiveBreaches = 3;
const maximumConsecutiveWindowGapMillis = windowMillis * 1.5;
const directionBreached = {
  above: (observed: number, threshold: number) => observed > threshold,
  below: (observed: number, threshold: number) => observed < threshold,
} as const;

const initialHealthSignalState: HealthSignalState = { alarm: false, breaches: 0, sampledAtMillis: -1 };

const isConsecutiveWindow = (state: HealthSignalState, sampledAtMillis: number) =>
  state.sampledAtMillis < 0 || sampledAtMillis - state.sampledAtMillis <= maximumConsecutiveWindowGapMillis;

const nextUtcDay = (millis: number) => (Math.floor(millis / dayMillis) + 1) * dayMillis;

const heapHeadroomPercent = (reading: ProcessHealthReading) => {
  if (reading.heapLimitBytes <= 0) return null;
  return (Math.max(0, reading.heapLimitBytes - reading.heapUsedBytes) / reading.heapLimitBytes) * 100;
};

const heapHealthSignal = (process: "daemon" | "renderer", reading: ProcessHealthReading) => {
  const observed = heapHeadroomPercent(reading);
  if (observed === null) return [];
  return [
    {
      signal: "heap-headroom",
      subsystem: process,
      observed,
      threshold: 25,
      unit: "%",
      direction: "below",
      sampledAtMillis: reading.sampledAtMillis,
    } satisfies HealthSignalReading,
  ];
};

const daemonHealthSignals = (reading: ProcessHealthReading) => [
  ...(reading.eventLoopDelayP99Millis === undefined
    ? []
    : [
        {
          signal: "event-loop-delay-p99",
          subsystem: "daemon",
          observed: reading.eventLoopDelayP99Millis,
          threshold: 100,
          unit: "ms",
          direction: "above",
          sampledAtMillis: reading.sampledAtMillis,
        } satisfies HealthSignalReading,
      ]),
  ...heapHealthSignal("daemon", reading),
];

const healthSignalReadings = (snapshot: PerformanceHealthSnapshot) => [
  ...(snapshot.daemon ? daemonHealthSignals(snapshot.daemon) : []),
  ...(snapshot.renderer ? heapHealthSignal("renderer", snapshot.renderer) : []),
];

const isBreached = (healthSignal: HealthSignalReading) =>
  directionBreached[healthSignal.direction](healthSignal.observed, healthSignal.threshold);

export const make = Effect.fn("PerformanceRegressionSensor.make")(function* (
  dependencies: PerformanceRegressionSensorDependencies,
) {
  const states = yield* Ref.make<ReadonlyMap<PerformanceIssueFingerprint, HealthSignalState>>(new Map());
  const gate = Semaphore.makeUnsafe(1);
  const setHealthSignalState = (fingerprint: PerformanceIssueFingerprint, state: HealthSignalState) =>
    Ref.update(states, (current) => new Map(current).set(fingerprint, state));

  const prepareFiling = Effect.fn("PerformanceRegressionSensor.prepareFiling")(function* (
    healthSignal: HealthSignalReading,
    capturedAtMillis: number,
  ) {
    const context = yield* dependencies.context;
    const evidencePath = yield* dependencies.writeEvidence({
      capturedAtMillis,
      healthSignal,
      windowMillis,
      consecutiveBreaches,
      context: { ...context, appVersion: dependencies.appVersion },
    });
    return {
      kind: "health-signal",
      signal: healthSignal.signal,
      subsystem: healthSignal.subsystem,
      direction: healthSignal.direction,
      observed: healthSignal.observed,
      threshold: healthSignal.threshold,
      unit: healthSignal.unit,
      windowMillis,
      consecutiveBreaches,
      evidence: {
        path: evidencePath,
        appVersion: dependencies.appVersion,
        runsInFlight: context.runsInFlight,
        workspaceCount: context.workspaceCount,
        machineLoad: context.machineLoad,
      },
    } satisfies PerformanceVerdict;
  });

  const submitPending = Effect.fn("PerformanceRegressionSensor.submitPending")(function* (
    healthSignal: HealthSignalReading,
    state: HealthSignalState,
    pending: PendingFiling,
  ) {
    const fingerprint = performanceVerdictFingerprint(healthSignal);
    const outcome = yield* dependencies.submit(pending.verdict, healthSignal.sampledAtMillis).pipe(
      Effect.catchIf(issueTrackerErrorIsPermanent, (error) =>
        Effect.logWarning("performance issue filing rejected", {
          fingerprint,
          reason: error.reason,
        }),
      ),
    );
    if (outcome === "capped") {
      yield* setHealthSignalState(fingerprint, {
        ...state,
        sampledAtMillis: healthSignal.sampledAtMillis,
        pending: { ...pending, retryAtMillis: nextUtcDay(healthSignal.sampledAtMillis) },
      });
      return true;
    }
    yield* setHealthSignalState(fingerprint, {
      alarm: true,
      breaches: state.breaches,
      sampledAtMillis: healthSignal.sampledAtMillis,
    });
    return false;
  });

  const handlePending = Effect.fn("PerformanceRegressionSensor.handlePending")(function* (
    healthSignal: HealthSignalReading,
    state: HealthSignalState,
    breached: boolean,
    fingerprint: PerformanceIssueFingerprint,
  ) {
    if (!state.pending) return false;
    if (state.pending.retryAtMillis !== undefined && !breached) return false;
    if (healthSignal.sampledAtMillis < (state.pending.retryAtMillis ?? 0)) {
      yield* setHealthSignalState(fingerprint, {
        ...state,
        sampledAtMillis: healthSignal.sampledAtMillis,
      });
      return true;
    }
    const remainsPending = yield* submitPending(healthSignal, state, state.pending);
    return remainsPending || breached;
  });

  const observeHealthSignal = Effect.fn("PerformanceRegressionSensor.observeHealthSignal")(function* (
    healthSignal: HealthSignalReading,
    capturedAtMillis: number,
  ) {
    const fingerprint = performanceVerdictFingerprint(healthSignal);
    const state = (yield* Ref.get(states)).get(fingerprint) ?? initialHealthSignalState;
    if (healthSignal.sampledAtMillis <= state.sampledAtMillis) return;
    const breached = isBreached(healthSignal);
    if (yield* handlePending(healthSignal, state, breached, fingerprint)) return;
    if (!breached) {
      return yield* setHealthSignalState(fingerprint, {
        alarm: false,
        breaches: 0,
        sampledAtMillis: healthSignal.sampledAtMillis,
      });
    }
    if (state.alarm) {
      return yield* setHealthSignalState(fingerprint, {
        ...state,
        sampledAtMillis: healthSignal.sampledAtMillis,
      });
    }
    const nextBreaches = isConsecutiveWindow(state, healthSignal.sampledAtMillis) ? state.breaches + 1 : 1;
    if (nextBreaches < consecutiveBreaches) {
      return yield* setHealthSignalState(fingerprint, {
        alarm: false,
        breaches: nextBreaches,
        sampledAtMillis: healthSignal.sampledAtMillis,
      });
    }
    const pending = yield* prepareFiling(healthSignal, capturedAtMillis);
    const pendingState = {
      alarm: false,
      breaches: nextBreaches,
      sampledAtMillis: healthSignal.sampledAtMillis,
      pending: { verdict: pending },
    } satisfies HealthSignalState;
    yield* setHealthSignalState(fingerprint, pendingState);
    yield* submitPending(healthSignal, pendingState, pendingState.pending);
  });

  const observeSignals = Effect.fn("PerformanceRegressionSensor.observeSignals")(function* (
    snapshot: PerformanceHealthSnapshot,
  ) {
    const results = yield* Effect.forEach(healthSignalReadings(snapshot), (healthSignal) =>
      Effect.result(observeHealthSignal(healthSignal, snapshot.sampledAtMillis)),
    );
    const failure = results.find(Result.isFailure);
    if (failure) return yield* failure.failure;
  });

  return {
    observe: Effect.fn("PerformanceRegressionSensor.observe")((snapshot: PerformanceHealthSnapshot) =>
      gate.withPermit(observeSignals(snapshot)),
    ),
  } satisfies PerformanceRegressionSensorService;
});

export interface PerformanceRegressionSensorOptions {
  readonly appVersion: string;
  readonly evidenceRoot: string;
}

const liveContext = Effect.fn("PerformanceRegressionSensor.context")(function* (
  schedulerState: Effect.Effect<SchedulerState>,
  registryState: Effect.Effect<RegistryState>,
) {
  const state = yield* schedulerState;
  const workspaces = yield* registryState;
  return {
    runsInFlight: state.global,
    workspaceCount: workspaces.workspaces.length,
    machineLoad: {
      cpuCount: availableParallelism(),
      loadAverage: loadavg(),
      freeMemoryBytes: freemem(),
    },
  } satisfies PerformanceEvidenceContext;
});

export const makeEvidenceWriter = Effect.fn("PerformanceRegressionSensor.evidenceWriter")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return Effect.fn("PerformanceRegressionSensor.writeEvidence")(function* (
    snapshot: PerformanceEvidenceSnapshot,
  ) {
    const directory = path.join(root, performanceVerdictFingerprint(snapshot.healthSignal));
    const evidencePath = path.join(directory, `${snapshot.capturedAtMillis}.json`);
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* fs.chmod(directory, 0o700);
    yield* fs.writeFileString(evidencePath, `${Formatter.formatJson(snapshot)}\n`, {
      flag: "w",
      mode: 0o600,
    });
    return evidencePath;
  });
});

export const layer = (options: PerformanceRegressionSensorOptions) =>
  Layer.effect(
    PerformanceRegressionSensor,
    Effect.gen(function* () {
      const filer = yield* PerformanceIssueFiler;
      const scheduler = yield* Scheduler;
      const registry = yield* WorkspaceRegistry;
      const writeEvidence = yield* makeEvidenceWriter(options.evidenceRoot);
      return yield* make({
        appVersion: options.appVersion,
        submit: filer.submit,
        writeEvidence,
        context: liveContext(scheduler.stats, registry.state),
      });
    }),
  );
