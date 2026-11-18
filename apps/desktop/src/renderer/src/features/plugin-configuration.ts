import {
  type Board,
  ContributionSettingScope,
  type ControlStore,
  contributionSettingApplies,
  type PluginItem,
  type PluginOverview,
} from "@cogwork/contracts";
import type * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import type * as AsyncResult from "effect/reactivity/AsyncResult";
import {
  Authority,
  type ConfigurationPicture,
  type Contribution,
  Diagnostic,
  type InstalledPlugin,
  LoadState,
  McpReadiness,
  type ScopeRef,
  type Workspace,
  type WorkspaceId,
} from "./configuration-model";
import { withDanglingSettings } from "./configuration-picture";

export const pluginOverviewOf = <E>(
  board: PluginOverview | null,
  queried: AsyncResult.AsyncResult<PluginOverview, E>,
) => {
  if (board) return board;
  if (queried._tag === "Success") return queried.value;
  return { plugins: [] };
};

export const pluginQueryFailure = <E>(
  queried: AsyncResult.AsyncResult<PluginOverview, E>,
): Cause.Cause<E> | null => (queried._tag === "Failure" ? queried.cause : null);

export type PluginLoadState = "loading" | "ready" | "failed";

declare const emptyVariant: unique symbol;
type EmptyVariant = { readonly [emptyVariant]?: never };

const pluginLoadStateOf = <E>(
  board: Pick<Board, "plugins"> | null,
  queried: AsyncResult.AsyncResult<PluginOverview, E>,
): PluginLoadState => {
  if (board?.plugins || queried._tag === "Success") return "ready";
  if (queried._tag === "Failure") return "failed";
  return "loading";
};

export type PluginDetailState = Data.TaggedEnum<{
  Loading: EmptyVariant;
  Failed: EmptyVariant;
  Missing: EmptyVariant;
  Ready: { readonly plugin: InstalledPlugin };
}>;

export const PluginDetailState = Data.taggedEnum<PluginDetailState>();

export const pluginDetailOf = (
  plugins: readonly InstalledPlugin[],
  pluginId: string,
  loadState: PluginLoadState,
): PluginDetailState => {
  const plugin = plugins.find((candidate) => candidate.record.pluginId === pluginId);
  if (plugin) return PluginDetailState.Ready({ plugin });
  if (loadState === "loading") return PluginDetailState.Loading({});
  if (loadState === "failed") return PluginDetailState.Failed({});
  return PluginDetailState.Missing({});
};

export const pluginSurfaceOf = <E>(
  board: Pick<Board, "plugins" | "pluginNotices"> | null,
  queried: AsyncResult.AsyncResult<PluginOverview, E>,
) => ({
  overview: pluginOverviewOf(board?.plugins ?? null, queried),
  notices: board?.pluginNotices ?? [],
  loadState: pluginLoadStateOf(board, queried),
});

const scopeOf = (setting: ControlStore["contributionSettings"][number]): ScopeRef =>
  ContributionSettingScope.match(setting.scope, {
    SettingsProfile: () => ({ kind: "settings-profile" }) satisfies ScopeRef,
    PrivateWorkspaceOverlay: ({ workspace }) =>
      ({ kind: "private-overlay", workspaceId: workspace }) satisfies ScopeRef,
  });

const settingApplies = (
  setting: ControlStore["contributionSettings"][number],
  contributionId: string,
  workspace: WorkspaceId | undefined,
) =>
  setting.contribution.id === contributionId && contributionSettingApplies(setting.scope, workspace ?? null);

const contributionWorkspaces = (
  contribution: PluginItem["contributions"][number],
  workspaces: readonly Workspace[],
) => {
  if (contribution.kind !== "mcp-server" || workspaces.length === 0) return [undefined];
  return workspaces.map((workspace) => workspace.id);
};

const contributionOf = (
  plugin: PluginItem,
  contribution: PluginItem["contributions"][number],
  controlStore: ControlStore | null,
  workspace: WorkspaceId | undefined,
): Contribution => ({
  id: contribution.id,
  kind: contribution.kind,
  localName: contribution.localName,
  authority: Authority.plugin({ pluginId: plugin.pluginId }),
  summary: contribution.summary,
  file: contribution.file,
  definedAt: "settings-profile",
  ...(workspace === undefined ? {} : { definedIn: workspace }),
  load:
    contribution.load._tag === "Loaded"
      ? LoadState.loaded({})
      : LoadState.failed({ reason: contribution.load.reason }),
  rows: (controlStore?.contributionSettings ?? [])
    .filter((setting) => settingApplies(setting, contribution.id, workspace))
    .map((setting) => ({
      scope: scopeOf(setting),
      value: setting.enabled,
      source: ContributionSettingScope.match(setting.scope, {
        SettingsProfile: () => "Control store",
        PrivateWorkspaceOverlay: () => "Private overlay",
      }),
      ...(setting.diagnostic
        ? {
            diagnostic: Diagnostic.dangling({
              source: setting.diagnostic.source,
              detail: setting.diagnostic.detail,
            }),
          }
        : {}),
    })),
  ...(contribution.kind === "mcp-server" && contribution.load._tag === "Loaded"
    ? {
        readiness: contribution.load.mcpServer?.credentialAvailable
          ? McpReadiness.ready({})
          : McpReadiness["not-ready"]({ reason: "Connection needed" }),
      }
    : {}),
});

const installedPluginOf = (plugin: PluginItem): InstalledPlugin | null => {
  if (!plugin.record) return null;
  const connectionReady = plugin.contributions.some(
    (contribution) => contribution.load._tag === "Loaded" && contribution.load.mcpServer?.credentialAvailable,
  );
  return {
    record: {
      pluginId: plugin.pluginId,
      resolvedIdentity: plugin.record.resolvedIdentity,
      principal: plugin.record.principal,
      installedAt: new Date(plugin.record.installedAtMillis).toISOString(),
    },
    name: plugin.name,
    summary: plugin.summary,
    manifestFailure: plugin.manifestFailure,
    contributionIds: plugin.contributions.map((contribution) => contribution.id),
    permissions: [
      { label: "Plugin files", detail: "Machine-local provisioned bundle", fidelity: "exact" },
      { label: "Contribution settings", detail: "User profile and private overlays", fidelity: "exact" },
    ],
    requiredConnections: plugin.requiredConnections,
    setup: plugin.requiredConnections.map((connection) => ({
      id: `${plugin.pluginId}:${connection}`,
      label: `Connect ${connection}`,
      detail: `Required by ${plugin.name}`,
      done: connectionReady,
    })),
  };
};

export const configurationWithPlugins = (
  base: ConfigurationPicture,
  overview: PluginOverview,
  controlStore: ControlStore | null,
): ConfigurationPicture => {
  const installed = overview.plugins.flatMap((plugin) => {
    const mapped = installedPluginOf(plugin);
    return mapped ? [mapped] : [];
  });
  const contributions = overview.plugins.flatMap((plugin) =>
    plugin.record
      ? plugin.contributions.flatMap((contribution) =>
          contributionWorkspaces(contribution, base.workspaces).map((workspace) =>
            contributionOf(plugin, contribution, controlStore, workspace),
          ),
        )
      : [],
  );
  return {
    ...base,
    plugins: installed,
    catalogPlugins: overview.plugins
      .filter((plugin) => plugin.record === null)
      .map(({ pluginId, name, summary, resolvedIdentity, manifestFailure }) => ({
        pluginId,
        name,
        summary,
        resolvedIdentity,
        manifestFailure,
      })),
    contributions: [
      ...base.contributions.filter((contribution) => !Authority.$is("plugin")(contribution.authority)),
      ...withDanglingSettings(contributions, controlStore?.contributionSettings ?? []),
    ],
  };
};
