import type { Board, ControlStore, PluginItem, PluginOverview } from "@cogwork/contracts";
import type * as Cause from "effect/Cause";
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type { ConfigurationPicture, Contribution, InstalledPlugin, ScopeRef } from "./configuration-model";

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

export const pluginSurfaceOf = <E>(
  board: Pick<Board, "plugins" | "pluginNotices"> | null,
  queried: AsyncResult.AsyncResult<PluginOverview, E>,
) => ({
  overview: pluginOverviewOf(board?.plugins ?? null, queried),
  notices: board?.pluginNotices ?? [],
});

const scopeOf = (setting: ControlStore["contributionSettings"][number]): ScopeRef =>
  setting.scope._tag === "SettingsProfile"
    ? { kind: "settings-profile" }
    : { kind: "private-overlay", workspaceId: setting.scope.workspace };

const contributionOf = (
  plugin: PluginItem,
  contribution: PluginItem["contributions"][number],
  controlStore: ControlStore | null,
): Contribution => ({
  id: contribution.id,
  kind: contribution.kind,
  localName: contribution.localName,
  authority: { _tag: "plugin", pluginId: plugin.pluginId },
  summary: contribution.summary,
  file: contribution.file,
  definedAt: "settings-profile",
  load:
    contribution.load._tag === "Loaded"
      ? { _tag: "loaded" }
      : { _tag: "failed", reason: contribution.load.reason },
  rows: (controlStore?.contributionSettings ?? [])
    .filter((setting) => setting.contribution === contribution.id)
    .map((setting) => ({
      scope: scopeOf(setting),
      value: setting.enabled,
      source: setting.scope._tag === "SettingsProfile" ? "Control store" : "Private overlay",
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
      ? plugin.contributions.map((contribution) => contributionOf(plugin, contribution, controlStore))
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
