import { DaemonRpcs, localOwner, Principal, PrincipalMiddleware } from "@cogwork/contracts";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Schedule from "effect/Schedule";
import { ControlStore } from "./control-store";
import { recoverCrashedRuns } from "./crash-recovery";
import { engineLayer, type HostAdapters } from "./daemon-engine";
import { handlersLayer } from "./daemon-handlers";
import { DaemonEventPublisher } from "./event-publisher";
import { PerformanceHealthSource } from "./performance-health-source";
import { reportDaemonProcessHealth } from "./performance-metrics";
import { PerformanceRegressionSensor } from "./performance-regression-sensor";
import { type DrainOptions, Scheduler } from "./scheduler";
import { maintainWorktrees } from "./worktree-maintenance";

export const serializationLayer = RpcSerialization.layerNdjson;

export const principalMiddlewareLayer = Layer.succeed(PrincipalMiddleware)(
  PrincipalMiddleware.of((effect) => Effect.provideService(effect, Principal, localOwner)),
);

export const serverLayer = <E, R>(adapters: HostAdapters<E, R>) =>
  RpcServer.layer(DaemonRpcs).pipe(
    Layer.provide(handlersLayer),
    Layer.provide(principalMiddlewareLayer),
    Layer.provide(adapters.transport),
    Layer.provide(serializationLayer),
    Layer.provideMerge(engineLayer(adapters)),
    Layer.provide(FetchHttpClient.layer),
  );

const continueAfterHeartbeatFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) =>
  Effect.catchCauseIf(
    effect,
    (cause) => !Cause.hasInterruptsOnly(cause),
    (cause) => Effect.logError(message, { cause }),
  );

const executeTick = Effect.fn("Daemon.executeHeartbeat")(function* () {
  const scheduler = yield* Scheduler;
  const publisher = yield* DaemonEventPublisher;
  yield* scheduler.tick();
  yield* publisher.publishScheduler();
});

const executeHeartbeat = () => executeTick().pipe(Effect.repeat(Schedule.spaced("5 seconds")));

const maintenanceTick = Effect.fn("Daemon.maintenanceHeartbeat")(function* () {
  const publisher = yield* DaemonEventPublisher;
  yield* publisher.publishWorkspaces();
  yield* maintainWorktrees();
});

const maintenanceHeartbeat = (pollIntervalMillis: number) =>
  continueAfterHeartbeatFailure(maintenanceTick(), "maintenance heartbeat failed").pipe(
    Effect.repeat(Schedule.spaced(pollIntervalMillis)),
  );

const performanceRegressionTick = Effect.fn("Daemon.performanceRegressionHeartbeat")(function* () {
  const source = yield* PerformanceHealthSource;
  const sensor = yield* PerformanceRegressionSensor;
  yield* sensor.observe(yield* source.snapshot);
});

const performanceRegressionHeartbeat = () =>
  continueAfterHeartbeatFailure(performanceRegressionTick(), "performance regression heartbeat failed").pipe(
    Effect.repeat(Schedule.spaced("10 seconds")),
    Effect.provideService(References.TracerEnabled, false),
  );

export interface HeartbeatOptions {
  readonly pollIntervalMillis: number;
  readonly drain: DrainOptions;
}

const activeHeartbeats = (options: HeartbeatOptions) =>
  continueAfterHeartbeatFailure(recoverCrashedRuns(), "crashed Run recovery failed").pipe(
    Effect.andThen(
      Effect.all([maintenanceHeartbeat(options.pollIntervalMillis), executeHeartbeat()], {
        concurrency: "unbounded",
      }),
    ),
    Effect.onInterrupt(() => Effect.flatMap(Scheduler, (scheduler) => scheduler.drain(options.drain))),
  );

const awaitHeartbeatInterruption = () => Effect.callback<never>(() => Effect.void);

const operationalHeartbeats = (options: HeartbeatOptions) =>
  Effect.flatMap(ControlStore, (controlStore) => {
    if (controlStore.health === "unavailable") return awaitHeartbeatInterruption();
    return activeHeartbeats(options);
  });

export const heartbeats = (options: HeartbeatOptions) =>
  Effect.all([operationalHeartbeats(options), reportDaemonProcessHealth, performanceRegressionHeartbeat()], {
    concurrency: "unbounded",
  });
