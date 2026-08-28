import type {
  Board,
  ContributionSettingDiagnostic,
  ContributionSettingRow,
  LocalContribution,
  LocalContributionAuthority,
  WorkspaceId,
} from "@cogwork/contracts";
import {
  type AuthoringTree,
  type ConfigurationPicture,
  type Contribution,
  contributionInstanceKey,
  type Diagnostic,
  type EnablementRow,
  type ScopeRef,
  type Workspace,
} from "./configuration-model";

const treeByAuthority: Record<LocalContributionAuthority, AuthoringTree> = {
  "local:user": "user",
  "local:repo": "repo",
  "local:private": "private",
};

const definedAtByAuthority: Record<LocalContributionAuthority, Contribution["definedAt"]> = {
  "local:user": "settings-profile",
  "local:repo": "workspace-input",
  "local:private": "private-overlay",
};

const settingScope = (row: ContributionSettingRow) =>
  row.scope._tag === "SettingsProfile"
    ? ({ kind: "settings-profile" } satisfies ScopeRef)
    : ({ kind: "private-overlay", workspaceId: row.scope.workspace } satisfies ScopeRef);

const diagnosticOf = (diagnostic: ContributionSettingDiagnostic) =>
  ({
    _tag: "dangling",
    source: diagnostic.source,
    detail: diagnostic.detail,
  }) satisfies Diagnostic;

const enablementRowOf = (row: ContributionSettingRow) =>
  ({
    scope: settingScope(row),
    value: row.enabled,
    source: "Control store",
    ...(row.diagnostic ? { diagnostic: diagnosticOf(row.diagnostic) } : {}),
  }) satisfies EnablementRow;

const settingApplies = (
  row: ContributionSettingRow,
  contribution: LocalContribution,
  workspace: WorkspaceId | undefined,
) => {
  if (row.contribution.id !== contribution.id) return false;
  if (row.scope._tag === "SettingsProfile") return true;
  if (workspace === undefined) return false;
  return row.scope.workspace === workspace;
};

const definedInWorkspace = (
  contribution: LocalContribution,
  workspace: WorkspaceId,
  rows: readonly ContributionSettingRow[],
) => {
  if (contribution.authority !== "local:user") return workspace;
  if (contribution.kind !== "mcp-server") return undefined;
  const hasOverlay = rows.some(
    (row) =>
      row.contribution.id === contribution.id &&
      row.scope._tag === "PrivateWorkspaceOverlay" &&
      row.scope.workspace === workspace,
  );
  return hasOverlay ? workspace : undefined;
};

const enablementRows = (
  contribution: LocalContribution,
  workspace: WorkspaceId | undefined,
  rows: readonly ContributionSettingRow[],
) => rows.filter((row) => settingApplies(row, contribution, workspace)).map(enablementRowOf);

const contributionOf = (
  contribution: LocalContribution,
  workspace: WorkspaceId,
  settings: readonly ContributionSettingRow[],
) => {
  const definedIn = definedInWorkspace(contribution, workspace, settings);
  return {
    id: contribution.id,
    kind: contribution.kind,
    localName: contribution.localName,
    authority: { _tag: "local", tree: treeByAuthority[contribution.authority] },
    summary: contribution.file,
    file: contribution.file,
    definedAt: definedAtByAuthority[contribution.authority],
    ...(definedIn === undefined ? {} : { definedIn }),
    load: { _tag: "loaded" },
    rows: enablementRows(contribution, definedIn, settings),
  } satisfies Contribution;
};

const registeredWorkspaces = (board: Board) =>
  [...board.workspaces.values()].flatMap((state) => (state._tag === "Registered" ? [state] : []));

const workspaceOf = (state: ReturnType<typeof registeredWorkspaces>[number]) =>
  ({
    id: state.name,
    name: state.displayName ?? state.name,
    checkoutPath: state.checkoutPath,
  }) satisfies Workspace;

const uniqueContributions = (contributions: readonly Contribution[]) => {
  const scoped = new Set(
    contributions.flatMap((contribution) => (contribution.definedIn === undefined ? [] : [contribution.id])),
  );
  const instances = contributions.filter(
    (contribution) => contribution.definedIn !== undefined || !scoped.has(contribution.id),
  );
  return [
    ...instances.reduce(
      (unique, contribution) => new Map(unique).set(contributionInstanceKey(contribution), contribution),
      new Map<string, Contribution>(),
    ),
  ].map(([, contribution]) => contribution);
};

const sameSettingScope = (enablement: EnablementRow, setting: ContributionSettingRow) => {
  const scope = settingScope(setting);
  return enablement.scope.kind === scope.kind && enablement.scope.workspaceId === scope.workspaceId;
};

const withDanglingSettings = (
  contributions: readonly Contribution[],
  settings: readonly ContributionSettingRow[],
) =>
  settings
    .filter((setting) => setting.diagnostic !== undefined)
    .reduce<readonly Contribution[]>((projected, setting) => {
      const matches = projected.filter((contribution) => contribution.id === setting.contribution.id);
      if (matches.some((contribution) => contribution.rows.some((row) => sameSettingScope(row, setting)))) {
        return projected;
      }
      const target = matches.find((contribution) => contribution.definedIn === undefined) ?? matches.at(0);
      if (target === undefined) return projected;
      return projected.map((contribution) =>
        contribution === target
          ? { ...contribution, rows: [...contribution.rows, enablementRowOf(setting)] }
          : contribution,
      );
    }, contributions);

export const configurationPicture = (board: Board) => {
  const registered = registeredWorkspaces(board);
  const settings = board.controlStore?.contributionSettings ?? [];
  const contributions = uniqueContributions(
    registered.flatMap((state) =>
      state.contributions.map((contribution) => contributionOf(contribution, state.name, settings)),
    ),
  );
  return {
    workspaces: registered.map(workspaceOf),
    plugins: [],
    contributions: withDanglingSettings(contributions, settings),
  } satisfies ConfigurationPicture;
};
