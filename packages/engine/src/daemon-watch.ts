import {
  agUiIsTerminal,
  type ConnectionOverview,
  type DaemonEvent,
  type RunActivity,
  type RunId,
  RunWatchItem,
} from "@cogwork/contracts";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ConnectionStore } from "./connection";
import { ControlStore, type ControlStoreService } from "./control-store";
import { DaemonEventBus, runActivityStream } from "./daemon-event-bus";
import { controlStoreWithDiagnostics, DaemonEventPublisher, readyToMergeEvents } from "./event-publisher";
import { HarnessReadinessCache } from "./harness-readiness";
import { PluginManager } from "./plugin";
import type { RegistryState } from "./projector";
import { schedulerStatsOf, workspaceStatesOf } from "./read-model";
import { WorkspaceRegistry } from "./registry-service";
import { RunLedger } from "./run-ledger";
import { RunRecorder } from "./run-recorder";
import { Scheduler } from "./scheduler";
import { Workflows } from "./workflow";

const watchedActivity = (activity: RunActivity) => ({ _tag: "RunActivity", activity }) satisfies RunWatchItem;

const historyEnd = { _tag: "HistoryEnd" } satisfies RunWatchItem;

const endsRun = (item: RunWatchItem) =>
  RunWatchItem.guards.RunActivity(item) && agUiIsTerminal(item.activity.event);

type ControlStoreSeedEvent = Omit<
  Extract<DaemonEvent, { readonly _tag: "ControlStoreChanged" }>,
  "emittedAtMillis"
>;
type PluginSeedEvent = Omit<Extract<DaemonEvent, { readonly _tag: "PluginsChanged" }>, "emittedAtMillis">;

const controlStoreSeedEvents = Effect.fn("Daemon.controlStoreSeedEvents")(function* (
  store: ControlStoreService,
  registry: RegistryState,
) {
  if (store.health === "unavailable") {
    yield* Effect.logError("Control store seed unavailable", { message: store.message });
    return [];
  }
  return yield* store.picture.pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.logError("Control store seed failed", { error }).pipe(Effect.map(() => [])),
      onSuccess: (controlStore) =>
        Effect.succeed([
          {
            _tag: "ControlStoreChanged",
            controlStore: controlStoreWithDiagnostics(controlStore, registry),
          } satisfies ControlStoreSeedEvent,
        ]),
    }),
  );
});

const connectionSeedEvent = (connections: ConnectionOverview) =>
  ({
    _tag: "ConnectionsChanged",
    connections,
    danglingWorkspaces: [],
  }) satisfies Omit<Extract<DaemonEvent, { readonly _tag: "ConnectionsChanged" }>, "emittedAtMillis">;

const pluginSeedEvent = (plugins: PluginSeedEvent["plugins"]) =>
  ({ _tag: "PluginsChanged", plugins, notices: [] }) satisfies PluginSeedEvent;

export const watchActivity = Effect.fn("Daemon.watchActivity")(function* (id: RunId | undefined) {
  const bus = yield* DaemonEventBus;
  if (id === undefined) return bus.activity.pipe(Stream.map(watchedActivity));

  const ledger = yield* RunLedger;
  const recorder = yield* RunRecorder;
  const subscription = yield* bus.subscribe();
  const run = yield* ledger.getRun(id);
  if (run === null) return Stream.empty;
  const historyHead = (yield* ledger.latestSeq(id)) ?? -1;
  const history = recorder.replay(run).pipe(
    Stream.takeWhile((item) => item.seq <= historyHead),
    Stream.map(watchedActivity),
    Stream.concat(Stream.make(historyEnd)),
  );
  const live = runActivityStream(Stream.fromSubscription(subscription)).pipe(
    Stream.filter((item) => item.runId === id && item.seq > historyHead),
    Stream.map(watchedActivity),
  );
  const settled = run.status !== "running";
  const base = settled ? history : Stream.concat(history, live);
  return base.pipe(Stream.takeUntil(endsRun));
});

const seedEvents = Effect.fn("Daemon.seedEvents")(function* () {
  const scheduler = yield* Scheduler;
  const controlStore = yield* ControlStore;
  const plugins = yield* PluginManager;
  const connections = yield* ConnectionStore;
  const harnesses = yield* HarnessReadinessCache;
  const workflows = yield* Workflows;
  const ledger = yield* RunLedger;
  const emittedAtMillis = yield* Clock.currentTimeMillis;
  const config = yield* scheduler.config;
  const stats = yield* scheduler.stats;
  const running = yield* ledger.runningRuns;
  const registry = yield* (yield* WorkspaceRegistry).state;
  const publisher = yield* DaemonEventPublisher;
  const readyToMerge = yield* publisher.readyToMerge;
  const queueEvent = { _tag: "QueueChanged", queue: yield* publisher.queue } as const;
  const workspaces = workspaceStatesOf(registry, readyToMerge).map(
    (workspace) => ({ _tag: "WorkspaceChanged", workspace }) as const,
  );
  const items = readyToMergeEvents(readyToMerge);
  const runs = running.map((run) => ({ _tag: "RunChanged", run }) as const);
  const scheduling = {
    _tag: "SchedulerChanged",
    scheduler: schedulerStatsOf(registry, config, stats),
  } as const;
  const controlStoreEvents = yield* controlStoreSeedEvents(controlStore, registry);
  const pluginEvents = yield* plugins.overview.pipe(
    Effect.matchEffect({
      onFailure: (error) => Effect.logError("Plugin seed failed", { error }).pipe(Effect.map(() => [])),
      onSuccess: (overview) => Effect.succeed([pluginSeedEvent(overview)]),
    }),
  );
  const connectionEvents = yield* connections.overview.pipe(
    Effect.match({
      onFailure: () => [],
      onSuccess: (overview) => [connectionSeedEvent(overview)],
    }),
  );
  const harnessEvent = {
    _tag: "HarnessesChanged" as const,
    readiness: yield* harnesses.readiness(
      controlStore.health === "available" ? controlStore.seed.harnessSettings : [],
    ),
  };
  const workflowEvents = yield* workflows.list.pipe(
    Effect.matchEffect({
      onFailure: (error) => Effect.logError("Workflow seed failed", { error }).pipe(Effect.map(() => [])),
      onSuccess: ({ workflows }) =>
        Effect.succeed(workflows.map((workflow) => ({ _tag: "WorkflowChanged", workflow }) as const)),
    }),
  );
  return [
    ...workspaces,
    ...items,
    ...runs,
    ...controlStoreEvents,
    ...pluginEvents,
    ...connectionEvents,
    ...workflowEvents,
    harnessEvent,
    scheduling,
    queueEvent,
  ].map((event) => ({ ...event, emittedAtMillis }));
});

// Subscribe before reading the seed so an event published between the two is not lost.
export const watchEvents = Effect.fn("Daemon.watchEvents")(function* () {
  const bus = yield* DaemonEventBus;
  const subscription = yield* bus.subscribe();
  const seed = yield* seedEvents();
  const emittedAtMillis = yield* Clock.currentTimeMillis;
  return Stream.concat(
    Stream.concat(Stream.fromIterable(seed), Stream.make({ _tag: "SeedEnd", emittedAtMillis })),
    Stream.fromSubscription(subscription),
  );
});
