import {
  ClassifiedItem,
  type ConnectionOverview,
  ContributionSettingScope,
  type ControlStore as ControlStorePicture,
  itemKey,
  type PluginOverview,
  SchedulerStats,
  type WorkItemId,
  type WorkspaceId,
  WorkspaceState,
  workspaceKey,
} from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ControlStore } from "./control-store";
import { DaemonEventBus } from "./daemon-event-bus";
import type { RegistryState } from "./projector";
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

const withoutContributionDiagnostic = ({
  diagnostic: _diagnostic,
  ...row
}: ControlStorePicture["contributionSettings"][number]) => row;

const contributionSettingAppliesToWorkspace = (
  scope: ControlStorePicture["contributionSettings"][number]["scope"],
  workspace: RegistryState["workspaces"][number],
) =>
  ContributionSettingScope.match(scope, {
    SettingsProfile: () => true,
    PrivateWorkspaceOverlay: ({ workspace: scopeWorkspace }) => workspace.config.name === scopeWorkspace,
  });

const contributionSettingScopeExists = (
  scope: ControlStorePicture["contributionSettings"][number]["scope"],
  registry: RegistryState,
) =>
  ContributionSettingScope.match(scope, {
    SettingsProfile: () => true,
    PrivateWorkspaceOverlay: ({ workspace: scopeWorkspace }) =>
      registry.workspaces.some((workspace) => workspace.config.name === scopeWorkspace),
  });

const contributionSettingInstalledByPlugin = (
  controlStore: ControlStorePicture,
  row: ControlStorePicture["contributionSettings"][number],
) =>
  controlStore.pluginInstalls.some(({ pluginId }) => row.contribution.id.startsWith(`plugin:${pluginId}/`));

const contributionSettingExistsInWorkspace = (
  registry: RegistryState,
  row: ControlStorePicture["contributionSettings"][number],
) =>
  registry.workspaces.some(
    (workspace) =>
      contributionSettingAppliesToWorkspace(row.scope, workspace) &&
      workspace.contributions.some((contribution) => contribution.id === row.contribution.id),
  );

const contributionSettingExists = (
  controlStore: ControlStorePicture,
  registry: RegistryState,
  row: ControlStorePicture["contributionSettings"][number],
) => {
  if (!contributionSettingScopeExists(row.scope, registry)) return false;
  if (contributionSettingInstalledByPlugin(controlStore, row)) return true;
  return contributionSettingExistsInWorkspace(registry, row);
};

export const controlStoreWithDiagnostics = (controlStore: ControlStorePicture, registry: RegistryState) => {
  const contributionSettings: ControlStorePicture["contributionSettings"] =
    controlStore.contributionSettings.map((stored) => {
      const row = withoutContributionDiagnostic(stored);
      if (contributionSettingExists(controlStore, registry, row)) return row;
      return {
        ...row,
        diagnostic: {
          _tag: "Dangling",
          source: "Control store",
          detail: `No loaded MCP server has identity ${row.contribution.id}. The setting remains stored and will apply if the contribution returns.`,
        },
      };
    });
  return {
    ...controlStore,
    contributionSettings,
  } satisfies ControlStorePicture;
};

export const make = Effect.gen(function* () {
  const worker = yield* ReconcileWorker;
  const scheduler = yield* Scheduler;
  const registry = yield* WorkspaceRegistry;
  const controlStore = yield* ControlStore;
  const bus = yield* DaemonEventBus;
  const lastItems = yield* Ref.make<ReadonlyMap<string, PublishedItem>>(new Map());
  const lastWorkspaces = yield* Ref.make<ReadonlyMap<string, PublishedWorkspace>>(new Map());
  const lastScheduler = yield* Ref.make<string | null>(null);
  const snapshotRefreshes = yield* Queue.sliding<void>(1);

  const publishControlStore = Effect.fn("DaemonEventPublisher.publishControlStore")(function* (
    picture: ControlStorePicture,
  ) {
    const published = controlStoreWithDiagnostics(picture, yield* registry.state);
    yield* bus.publish({ _tag: "ControlStoreChanged", controlStore: published });
    return published;
  });

  const refreshControlStore = Effect.fn("DaemonEventPublisher.refreshControlStore")(function* () {
    if (controlStore.health === "unavailable") return;
    yield* controlStore.withWrite(
      controlStore.picture.pipe(
        Effect.flatMap(publishControlStore),
        Effect.catchTag("ControlStoreFailure", (error) =>
          Effect.logWarning("Control store diagnostic refresh failed", { message: error.message }),
        ),
      ),
    );
  });

  const publishItems = Effect.fn("DaemonEventPublisher.publishItems")(function* () {
    const snapshot = yield* worker.snapshot;
    const signed = currentReconcileStatesOf(yield* registry.state, snapshot).flatMap((state) =>
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
    const states = workspaceStatesOf(yield* registry.state, snapshot);
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
    if (changed.length > 0 || removed.length > 0) yield* refreshControlStore();
    return states;
  });

  const publishScheduler = Effect.fn("DaemonEventPublisher.publishScheduler")(function* () {
    const config = yield* scheduler.config;
    const state = yield* scheduler.stats;
    const stats = schedulerStatsOf(yield* registry.state, config, state);
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

  const publishPlugins = Effect.fn("DaemonEventPublisher.publishPlugins")(function* (
    plugins: PluginOverview,
    notices: readonly string[],
  ) {
    yield* bus.publish({ _tag: "PluginsChanged", plugins, notices });
    return plugins;
  });
  const publishConnections = Effect.fn("DaemonEventPublisher.publishConnections")(function* (
    connections: ConnectionOverview,
    danglingWorkspaces: readonly WorkspaceId[],
  ) {
    yield* bus.publish({ _tag: "ConnectionsChanged", connections, danglingWorkspaces });
    return connections;
  });

  yield* Queue.take(snapshotRefreshes).pipe(
    Effect.flatMap(() =>
      worker.submitAfterCurrent().pipe(
        Effect.ignore,
        Effect.andThen(publishItems()),
        Effect.andThen(publishWorkspaces()),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logError("snapshot refresh publication failed", { cause }),
        ),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  const requestSnapshotRefresh = Effect.fn("DaemonEventPublisher.requestSnapshotRefresh")(function* () {
    yield* Queue.offer(snapshotRefreshes, undefined);
  });

  return {
    publishItems,
    publishWorkspaces,
    publishWorkspaceRemoved,
    publishScheduler,
    publishControlStore,
    publishPlugins,
    publishConnections,
    requestSnapshotRefresh,
  } as const;
});

export type DaemonEventPublisherService = Effect.Success<typeof make>;

export class DaemonEventPublisher extends Context.Service<
  DaemonEventPublisher,
  DaemonEventPublisherService
>()("@cogwork/engine/event-publisher/DaemonEventPublisher") {}

export const layer = Layer.effect(DaemonEventPublisher, make);
