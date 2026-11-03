import {
  type ConnectionOverview,
  ContributionSettingScope,
  type ControlStore as ControlStorePicture,
  type PluginOverview,
  type ReadyToMergeItem,
  type WorkItemId,
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { DaemonEventBus } from "./daemon-event-bus";
import type { RegistryState } from "./projector";
import { readyToMergeByWorkspace, schedulerStatsOf, workspaceStatesOf } from "./read-model";
import { WorkspaceRegistry } from "./registry";
import { Scheduler } from "./scheduler";

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
  const scheduler = yield* Scheduler;
  const registry = yield* WorkspaceRegistry;
  const bus = yield* DaemonEventBus;
  const publishedItems = yield* Ref.make(
    new Map<string, { readonly workspace: WorkspaceId; readonly id: WorkItemId }>(),
  );

  const publishItems = Effect.fn("DaemonEventPublisher.publishItems")(function* (
    readyToMerge: ReadonlyMap<WorkspaceId, ReadonlyArray<ReadyToMergeItem>>,
  ) {
    const current = new Map<string, { readonly workspace: WorkspaceId; readonly id: WorkItemId }>(
      [...readyToMerge].flatMap(([workspace, items]) =>
        items.map((item) => [`${workspace}::${item.id}`, { workspace, id: item.id }] as const),
      ),
    );
    const previous = yield* Ref.get(publishedItems);
    yield* Effect.forEach(
      [...previous].filter(([key]) => !current.has(key)),
      ([, item]) => bus.publish({ _tag: "ItemRemoved", ...item }),
      { discard: true },
    );
    yield* Effect.forEach(
      [...readyToMerge],
      ([workspace, items]) =>
        Effect.forEach(
          items,
          (item) =>
            bus.publish({
              _tag: "ItemChanged",
              workspace,
              item: { _tag: "ReadyToMerge", ...item },
            }),
          { discard: true },
        ),
      { discard: true },
    );
    yield* Ref.set(publishedItems, current);
  });

  const publishWorkspaces = Effect.fn("DaemonEventPublisher.publishWorkspaces")(function* () {
    const state = yield* registry.state;
    const readyToMerge = yield* readyToMergeByWorkspace(state);
    const workspaces = workspaceStatesOf(state, readyToMerge);
    yield* Effect.forEach(workspaces, (workspace) => bus.publish({ _tag: "WorkspaceChanged", workspace }), {
      discard: true,
    });
    yield* publishItems(readyToMerge);
    return workspaces;
  });

  const publishWorkspaceRemoved = (workspace: WorkspaceId) =>
    bus.publish({ _tag: "WorkspaceRemoved", workspace });

  const publishScheduler = Effect.fn("DaemonEventPublisher.publishScheduler")(function* () {
    const state = yield* registry.state;
    const config = yield* scheduler.config;
    const stats = schedulerStatsOf(state, config, yield* scheduler.stats);
    yield* bus.publish({ _tag: "SchedulerChanged", scheduler: stats });
    return stats;
  });

  const publishControlStore = Effect.fn("DaemonEventPublisher.publishControlStore")(function* (
    controlStore: ControlStorePicture,
  ) {
    const state = yield* registry.state;
    const diagnosed = controlStoreWithDiagnostics(controlStore, state);
    yield* bus.publish({ _tag: "ControlStoreChanged", controlStore: diagnosed });
    return diagnosed;
  });

  const publishPlugins = (plugins: PluginOverview, notices: ReadonlyArray<string> = []) =>
    bus.publish({ _tag: "PluginsChanged", plugins, notices });

  const publishConnections = (connections: ConnectionOverview, danglingWorkspaces: readonly WorkspaceId[]) =>
    bus.publish({ _tag: "ConnectionsChanged", connections, danglingWorkspaces });

  return {
    publishWorkspaces,
    publishWorkspaceRemoved,
    publishScheduler,
    publishControlStore,
    publishPlugins,
    publishConnections,
  } as const;
});

export type DaemonEventPublisherService = Effect.Success<typeof make>;

export class DaemonEventPublisher extends Context.Service<
  DaemonEventPublisher,
  DaemonEventPublisherService
>()("@cogwork/engine/event-publisher/DaemonEventPublisher") {}

export const layer = Layer.effect(DaemonEventPublisher, make);
