import {
  type Board,
  type ContributionSettingDiagnostic,
  type ContributionSettingRow,
  ContributionSettingScope,
  type LocalContribution,
  type LocalContributionAuthority,
  type WorkspaceId,
  WorkspaceState,
} from "@cogwork/contracts";
import {
  type AuthoringTree,
  Authority,
  type ConfigurationPicture,
  type Contribution,
  contributionInstanceKey,
  Diagnostic,
  type EnablementRow,
  LoadState,
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

const settingScope = (row: ContributionSettingRow): ScopeRef =>
  ContributionSettingScope.match(row.scope, {
    SettingsProfile: () => ({ kind: "settings-profile" }) satisfies ScopeRef,
    PrivateWorkspaceOverlay: ({ workspace }) =>
      ({ kind: "private-overlay", workspaceId: workspace }) satisfies ScopeRef,
  });

const diagnosticOf = (diagnostic: ContributionSettingDiagnostic) =>
  Diagnostic.dangling({
    source: diagnostic.source,
    detail: diagnostic.detail,
  });

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
  if (ContributionSettingScope.guards.SettingsProfile(row.scope)) return true;
  if (workspace === undefined) return false;
  return row.scope.workspace === workspace;
};

const definedInWorkspace = (contribution: LocalContribution, workspace: WorkspaceId) => {
  if (contribution.authority === "local:user" && contribution.kind !== "mcp-server") return undefined;
  return workspace;
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
  const definedIn = definedInWorkspace(contribution, workspace);
  return {
    id: contribution.id,
    kind: contribution.kind,
    localName: contribution.localName,
    authority: Authority.local({ tree: treeByAuthority[contribution.authority] }),
    summary: contribution.file,
    file: contribution.file,
    definedAt: definedAtByAuthority[contribution.authority],
    ...(definedIn === undefined ? {} : { definedIn }),
    load: LoadState.loaded({}),
    rows: enablementRows(contribution, definedIn, settings),
  } satisfies Contribution;
};

const registeredWorkspaces = (board: Board) =>
  [...board.workspaces.values()].filter(WorkspaceState.guards.Registered);

const workspaceOf = (state: ReturnType<typeof registeredWorkspaces>[number]) =>
  ({
    id: state.id,
    name: state.displayName,
    checkoutPath: state.checkoutPath,
  }) satisfies Workspace;

const uniqueContributions = (contributions: readonly Contribution[]) =>
  [
    ...contributions.reduce(
      (unique, contribution) => new Map(unique).set(contributionInstanceKey(contribution), contribution),
      new Map<string, Contribution>(),
    ),
  ].map(([, contribution]) => contribution);

const sameSettingScope = (enablement: EnablementRow, setting: ContributionSettingRow) => {
  const scope = settingScope(setting);
  return enablement.scope.kind === scope.kind && enablement.scope.workspaceId === scope.workspaceId;
};

const danglingContribution = (matches: readonly Contribution[], setting: ContributionSettingRow) => {
  if (!ContributionSettingScope.guards.PrivateWorkspaceOverlay(setting.scope)) return undefined;
  const prototype = matches.at(0);
  if (prototype === undefined) return undefined;
  const { definedIn: _definedIn, ...contribution } = prototype;
  return {
    ...contribution,
    definedIn: setting.scope.workspace,
    rows: [...prototype.rows.filter((row) => row.scope.workspaceId === undefined), enablementRowOf(setting)],
  };
};

export const withDanglingSettings = (
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
      const dangling = danglingContribution(matches, setting);
      return dangling ? projected.concat(dangling) : projected;
    }, contributions);

export const configurationPicture = (board: Board) => {
  const registered = registeredWorkspaces(board);
  const settings = board.controlStore?.contributionSettings ?? [];
  const contributions = uniqueContributions(
    registered.flatMap((state) =>
      state.contributions.map((contribution) => contributionOf(contribution, state.id, settings)),
    ),
  );
  return {
    workspaces: registered.map(workspaceOf),
    plugins: [],
    catalogPlugins: [],
    contributions: withDanglingSettings(contributions, settings),
  } satisfies ConfigurationPicture;
};
