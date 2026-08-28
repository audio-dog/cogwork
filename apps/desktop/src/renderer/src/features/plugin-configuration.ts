import type { Board, ControlStore, PluginItem, PluginOverview } from "@cogwork/contracts";
import type * as Cause from "effect/Cause";
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type {
  ConfigurationPicture,
  Contribution,
  InstalledPlugin,
  ScopeRef,
  Workspace,
  WorkspaceId,
} from "./configuration-model";

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

const pluginLoadStateOf = <E>(
  board: Pick<Board, "plugins"> | null,
  queried: AsyncResult.AsyncResult<PluginOverview, E>,
): PluginLoadState => {
  if (board?.plugins || queried._tag === "Success") return "ready";
  if (queried._tag === "Failure") return "failed";
  return "loading";
};

export type PluginDetailState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failed" }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Ready"; readonly plugin: InstalledPlugin };

export const pluginDetailOf = (
  plugins: readonly InstalledPlugin[],
  pluginId: string,
  loadState: PluginLoadState,
): PluginDetailState => {
  const plugin = plugins.find((candidate) => candidate.record.pluginId === pluginId);
  if (plugin) return { _tag: "Ready", plugin };
  if (loadState === "loading") return { _tag: "Loading" };
  if (loadState === "failed") return { _tag: "Failed" };
  return { _tag: "Missing" };
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
  setting.scope._tag === "SettingsProfile"
    ? { kind: "settings-profile" }
    : { kind: "private-overlay", workspaceId: setting.scope.workspace };

const settingApplies = (
  setting: ControlStore["contributionSettings"][number],
  contributionId: string,
  workspace: WorkspaceId | undefined,
) => {
  if (setting.contribution.id !== contributionId) return false;
  if (setting.scope._tag === "SettingsProfile") return true;
  return setting.scope.workspace === workspace;
};

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
  authority: { _tag: "plugin", pluginId: plugin.pluginId },
  summary: contribution.summary,
  file: contribution.file,
  definedAt: "settings-profile",
  ...(workspace === undefined ? {} : { definedIn: workspace }),
  load:
    contribution.load._tag === "Loaded"
      ? { _tag: "loaded" }
      : { _tag: "failed", reason: contribution.load.reason },
  rows: (controlStore?.contributionSettings ?? [])
    .filter((setting) => settingApplies(setting, contribution.id, workspace))
    .map((setting) => ({
      scope: scopeOf(setting),
      value: setting.enabled,
      source: setting.scope._tag === "SettingsProfile" ? "Control store" : "Private overlay",
      ...(setting.diagnostic
        ? {
            diagnostic: {
              _tag: "dangling" as const,
              source: setting.diagnostic.source,
              detail: setting.diagnostic.detail,
            },
          }
        : {}),
    })),
  ...(contribution.kind === "mcp-server" && contribution.load._tag === "Loaded"
    ? {
        readiness: contribution.load.mcpServer?.credentialAvailable
          ? { _tag: "ready" as const }
          : { _tag: "not-ready" as const, reason: "Connection needed" },
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
      ...base.contributions.filter((contribution) => contribution.authority._tag !== "plugin"),
      ...contributions,
    ],
  };
};
