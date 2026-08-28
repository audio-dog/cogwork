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

const settingApplies = (
  row: ContributionSettingRow,
  contribution: LocalContribution,
  workspace: WorkspaceId | undefined,
) => {
  if (row.contribution.id !== contribution.id) return false;
  if (row.scope._tag === "SettingsProfile") return true;
  if (workspace === undefined) return true;
  return row.scope.workspace === workspace;
};

const enablementRows = (
  contribution: LocalContribution,
  workspace: WorkspaceId | undefined,
  rows: readonly ContributionSettingRow[],
) =>
  rows
    .filter((row) => settingApplies(row, contribution, workspace))
    .map(
      (row) =>
        ({
          scope: settingScope(row),
          value: row.enabled,
          source: "Control store",
          ...(row.diagnostic ? { diagnostic: diagnosticOf(row.diagnostic) } : {}),
        }) satisfies EnablementRow,
    );

const contributionOf = (
  contribution: LocalContribution,
  workspace: WorkspaceId,
  settings: readonly ContributionSettingRow[],
) =>
  ({
    id: contribution.id,
    kind: contribution.kind,
    localName: contribution.localName,
    authority: { _tag: "local", tree: treeByAuthority[contribution.authority] },
    summary: contribution.file,
    file: contribution.file,
    definedAt: definedAtByAuthority[contribution.authority],
    ...(contribution.authority === "local:user" ? {} : { definedIn: workspace }),
    load: { _tag: "loaded" },
    rows: enablementRows(
      contribution,
      contribution.authority === "local:user" ? undefined : workspace,
      settings,
    ),
  }) satisfies Contribution;

const registeredWorkspaces = (board: Board) =>
  [...board.workspaces.values()].flatMap((state) => (state._tag === "Registered" ? [state] : []));

const workspaceOf = (state: ReturnType<typeof registeredWorkspaces>[number]) =>
  ({
    id: state.name,
    name: state.displayName ?? state.name,
    checkoutPath: state.checkoutPath,
  }) satisfies Workspace;

const uniqueContributions = (contributions: readonly Contribution[]) =>
  [
    ...contributions.reduce(
      (unique, contribution) => new Map(unique).set(contributionInstanceKey(contribution), contribution),
      new Map<string, Contribution>(),
    ),
  ].map(([, contribution]) => contribution);

export const configurationPicture = (board: Board) => {
  const registered = registeredWorkspaces(board);
  const settings = board.controlStore?.contributionSettings ?? [];
  return {
    workspaces: registered.map(workspaceOf),
    plugins: [],
    contributions: uniqueContributions(
      registered.flatMap((state) =>
        state.contributions.map((contribution) => contributionOf(contribution, state.name, settings)),
      ),
    ),
  } satisfies ConfigurationPicture;
};
