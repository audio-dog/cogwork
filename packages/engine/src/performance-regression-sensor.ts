import { availableParallelism, freemem, loadavg } from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Formatter from "effect/Formatter";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type { IssueTrackerError } from "./issue-tracker";
import {
  PerformanceIssueFiler,
  type PerformanceIssueFilerService,
  type PerformanceIssueInput,
} from "./performance-issue-filer";
import type { RegistryState } from "./projector";
import { WorkspaceRegistry } from "./registry";
import { Scheduler, type SchedulerState } from "./scheduler";

interface ProcessHealthReading {
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
  readonly snapshot: Effect.Effect<PerformanceHealthSnapshot>;
}

export class PerformanceHealthSource extends Context.Service<
  PerformanceHealthSource,
  PerformanceHealthSourceService
>()("@cogwork/engine/performance-regression-sensor/PerformanceHealthSource") {}

export const healthSourceLayer = (snapshot: Effect.Effect<PerformanceHealthSnapshot>) =>
  Layer.succeed(PerformanceHealthSource, PerformanceHealthSource.of({ snapshot }));

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
  readonly fingerprint: string;
  readonly title: string;
  readonly display: string;
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
  readonly pending?: PerformanceIssueInput;
  readonly pendingAtMillis?: number;
}

const windowMillis = 10_000;
const consecutiveBreaches = 3;

const initialHealthSignalState: HealthSignalState = { alarm: false, breaches: 0, sampledAtMillis: -1 };

const heapHeadroomPercent = (reading: ProcessHealthReading) => {
  if (reading.heapLimitBytes <= 0) return null;
  return (Math.max(0, reading.heapLimitBytes - reading.heapUsedBytes) / reading.heapLimitBytes) * 100;
};

const heapHealthSignal = (process: "daemon" | "renderer", reading: ProcessHealthReading) => {
  const observed = heapHeadroomPercent(reading);
  if (observed === null) return [];
  const label = process === "daemon" ? "Daemon" : "Renderer";
  return [
    {
      fingerprint: `${process}.heap-headroom.below`,
      title: `${label} heap headroom fell below 25%`,
      display: `${process} heap headroom below threshold`,
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
          fingerprint: "daemon.event-loop-delay-p99.above",
          title: "Daemon event-loop delay p99 exceeded 100 ms",
          display: "daemon event-loop delay p99 above threshold",
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
  healthSignal.direction === "above"
    ? healthSignal.observed > healthSignal.threshold
    : healthSignal.observed < healthSignal.threshold;

const formatValue = (value: number) => Number(value.toFixed(2));

const thresholdText = (healthSignal: HealthSignalReading) =>
  `${healthSignal.direction === "above" ? ">" : "<"} ${healthSignal.threshold} ${healthSignal.unit}`;

const occurrenceLines = (healthSignal: HealthSignalReading) => [
  `Observed: ${formatValue(healthSignal.observed)} ${healthSignal.unit}`,
  `Threshold: ${thresholdText(healthSignal)}`,
  `Window: ${windowMillis / 1_000} seconds`,
  `Consecutive breaches: ${consecutiveBreaches}`,
];

const signalBody = (
  healthSignal: HealthSignalReading,
  context: PerformanceEvidenceContext,
  appVersion: string,
  evidencePath: string,
) =>
  [
    `Signal: ${healthSignal.display}`,
    ...occurrenceLines(healthSignal),
    `Runs in flight: ${context.runsInFlight}`,
    `Workspace count: ${context.workspaceCount}`,
    `Cogwork version: ${appVersion}`,
    `Machine load: CPUs=${context.machineLoad.cpuCount}; averages=${context.machineLoad.loadAverage.join(", ")}; free memory=${context.machineLoad.freeMemoryBytes} bytes`,
    `Evidence: ${evidencePath}`,
    `Close when: ${healthSignal.display.replace("above threshold", "is at or below the threshold").replace("below threshold", "is at or above the threshold")} over a ${windowMillis / 1_000}-second window.`,
  ].join("\n\n");

const recurrenceBody = (healthSignal: HealthSignalReading, evidencePath: string) =>
  ["Fired again.", ...occurrenceLines(healthSignal), `Evidence: ${evidencePath}`].join("\n\n");

export const make = Effect.fn("PerformanceRegressionSensor.make")(function* (
  dependencies: PerformanceRegressionSensorDependencies,
) {
  const states = yield* Ref.make<ReadonlyMap<string, HealthSignalState>>(new Map());
  const gate = Semaphore.makeUnsafe(1);
  const setHealthSignalState = (fingerprint: string, state: HealthSignalState) =>
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
      fingerprint: healthSignal.fingerprint,
      title: healthSignal.title,
      body: signalBody(healthSignal, context, dependencies.appVersion, evidencePath),
      recurrenceBody: recurrenceBody(healthSignal, evidencePath),
    } satisfies PerformanceIssueInput;
  });

  const submitPending = Effect.fn("PerformanceRegressionSensor.submitPending")(function* (
    healthSignal: HealthSignalReading,
    state: HealthSignalState,
  ) {
    if (!state.pending || state.pendingAtMillis === undefined) return false;
    yield* dependencies.submit(state.pending, state.pendingAtMillis);
    yield* setHealthSignalState(healthSignal.fingerprint, {
      alarm: true,
      breaches: state.breaches,
      sampledAtMillis: healthSignal.sampledAtMillis,
    });
    return true;
  });

  const observeHealthSignal = Effect.fn("PerformanceRegressionSensor.observeHealthSignal")(function* (
    healthSignal: HealthSignalReading,
    capturedAtMillis: number,
  ) {
    const state = (yield* Ref.get(states)).get(healthSignal.fingerprint) ?? initialHealthSignalState;
    if (healthSignal.sampledAtMillis <= state.sampledAtMillis) return;
    if (!isBreached(healthSignal)) {
      return yield* setHealthSignalState(healthSignal.fingerprint, {
        alarm: false,
        breaches: 0,
        sampledAtMillis: healthSignal.sampledAtMillis,
      });
    }
    if (state.alarm) {
      return yield* setHealthSignalState(healthSignal.fingerprint, {
        ...state,
        sampledAtMillis: healthSignal.sampledAtMillis,
      });
    }
    if (yield* submitPending(healthSignal, state)) return;
    const nextBreaches = state.breaches + 1;
    if (nextBreaches < consecutiveBreaches) {
      return yield* setHealthSignalState(healthSignal.fingerprint, {
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
      pending,
      pendingAtMillis: capturedAtMillis,
    } satisfies HealthSignalState;
    yield* setHealthSignalState(healthSignal.fingerprint, pendingState);
    yield* submitPending(healthSignal, pendingState);
  });

  return {
    observe: Effect.fn("PerformanceRegressionSensor.observe")((snapshot: PerformanceHealthSnapshot) =>
      gate.withPermit(
        Effect.forEach(
          healthSignalReadings(snapshot),
          (healthSignal) => observeHealthSignal(healthSignal, snapshot.sampledAtMillis),
          {
            discard: true,
          },
        ),
      ),
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
    const directory = path.join(root, snapshot.healthSignal.fingerprint);
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
