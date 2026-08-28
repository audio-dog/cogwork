import {
  ClassifiedItem,
  type ControlStore as ControlStorePicture,
  itemKey,
  type PluginOverview,
  SchedulerStats,
  type WorkItemId,
  type WorkspaceId,
  WorkspaceState,
  workspaceKey,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { DaemonEventBus } from "./daemon-event-bus";
import {
  classifiedItemsOf,
  currentReconcileStatesOf,
  schedulerStatsOf,
  workspaceStatesOf,
} from "./read-model";
import { ReconcileWorker } from "./reconcile";
import { WorkspaceRegistry } from "./registry";
import { Scheduler } from "./scheduler";

const encodeItem = Schema.encodeSync(Schema.fromJsonString(ClassifiedItem));
const encodeStats = Schema.encodeSync(Schema.fromJsonString(SchedulerStats));
const encodeWorkspace = Schema.encodeSync(Schema.fromJsonString(WorkspaceState));

interface PublishedItem {
  readonly signature: string;
  readonly workspace: WorkspaceId;
  readonly id: WorkItemId;
}

interface PublishedWorkspace {
  readonly signature: string;
  readonly state: WorkspaceState;
}

export const make = Effect.gen(function* () {
  const worker = yield* ReconcileWorker;
  const scheduler = yield* Scheduler;
  const registry = yield* WorkspaceRegistry;
  const bus = yield* DaemonEventBus;
  const lastItems = yield* Ref.make<ReadonlyMap<string, PublishedItem>>(new Map());
  const lastWorkspaces = yield* Ref.make<ReadonlyMap<string, PublishedWorkspace>>(new Map());
  const lastScheduler = yield* Ref.make<string | null>(null);

  const publishItems = Effect.fn("DaemonEventPublisher.publishItems")(function* () {
    const snapshot = yield* worker.snapshot;
    const signed = currentReconcileStatesOf(registry, snapshot).flatMap((state) =>
      classifiedItemsOf(state).map(
        (item) =>
          ({
            key: itemKey(state.name, item.id),
            signature: `${state.name}::${encodeItem(item)}`,
            workspace: state.name,
            item,
          }) as const,
      ),
    );
    const previous = yield* Ref.get(lastItems);
    const present = new Set(signed.map(({ key }) => key));
    const changed = signed.filter(({ key, signature }) => previous.get(key)?.signature !== signature);
    const removed = [...previous].filter(([key]) => !present.has(key));
    yield* Effect.forEach(
      changed,
      ({ workspace, item }) => bus.publish({ _tag: "ItemChanged", workspace, item }),
      { discard: true },
    );
    yield* Effect.forEach(
      removed,
      ([, { workspace, id }]) => bus.publish({ _tag: "ItemRemoved", workspace, id }),
      { discard: true },
    );
    yield* Ref.set(
      lastItems,
      new Map(
        signed.map(
          ({ key, signature, workspace, item }) => [key, { signature, workspace, id: item.id }] as const,
        ),
      ),
    );
  });

  const publishWorkspaces = Effect.fn("DaemonEventPublisher.publishWorkspaces")(function* () {
    const snapshot = yield* worker.snapshot;
    const states = workspaceStatesOf(registry, snapshot);
    const previous = yield* Ref.get(lastWorkspaces);
    const signed = states.map((state) => ({
      key: workspaceKey(state),
      signature: encodeWorkspace(state),
      state,
    }));
    const present = new Set(signed.map(({ key }) => key));
    const changed = signed.filter(({ key, signature }) => previous.get(key)?.signature !== signature);
    const removed = [...previous].flatMap(([key, published]) => {
      if (present.has(key) || published.state.name === undefined) return [];
      return [published.state.name];
    });
    yield* Effect.forEach(
      changed,
      ({ state }) => bus.publish({ _tag: "WorkspaceChanged", workspace: state }),
      { discard: true },
    );
    yield* Effect.forEach(removed, (workspace) => bus.publish({ _tag: "WorkspaceRemoved", workspace }), {
      discard: true,
    });
    yield* Ref.set(
      lastWorkspaces,
      new Map(signed.map(({ key, signature, state }) => [key, { signature, state }] as const)),
    );
  });

  const publishScheduler = Effect.fn("DaemonEventPublisher.publishScheduler")(function* () {
    const stats = schedulerStatsOf(registry, yield* scheduler.config, yield* scheduler.stats);
    const signature = encodeStats(stats);
    if ((yield* Ref.get(lastScheduler)) === signature) return stats;
    yield* Ref.set(lastScheduler, signature);
    yield* bus.publish({ _tag: "SchedulerChanged", scheduler: stats });
    return stats;
  });

  const publishWorkspaceRemoved = Effect.fn("DaemonEventPublisher.publishWorkspaceRemoved")(function* (
    workspace: WorkspaceId,
  ) {
    yield* Ref.update(
      lastWorkspaces,
      (current) => new Map([...current].filter(([key]) => key !== workspace)),
    );
    yield* bus.publish({ _tag: "WorkspaceRemoved", workspace });
    return workspace;
  });

  const publishControlStore = Effect.fn("DaemonEventPublisher.publishControlStore")(function* (
    controlStore: ControlStorePicture,
  ) {
    yield* bus.publish({ _tag: "ControlStoreChanged", controlStore });
    return controlStore;
  });

  const publishPlugins = Effect.fn("DaemonEventPublisher.publishPlugins")(function* (
    plugins: PluginOverview,
    notices: readonly string[],
  ) {
    yield* bus.publish({ _tag: "PluginsChanged", plugins, notices });
    return plugins;
  });

  return {
    publishItems,
    publishWorkspaces,
    publishWorkspaceRemoved,
    publishScheduler,
    publishControlStore,
    publishPlugins,
  } as const;
});

export type DaemonEventPublisherService = Effect.Success<typeof make>;

export class DaemonEventPublisher extends Context.Service<
  DaemonEventPublisher,
  DaemonEventPublisherService
>()("@cogwork/engine/event-publisher/DaemonEventPublisher") {}

export const layer = Layer.effect(DaemonEventPublisher, make);
