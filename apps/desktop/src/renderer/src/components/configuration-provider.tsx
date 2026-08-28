import type { ContributionSettingCell, ContributionSettingUpdate, ControlStore } from "@cogwork/contracts";
import { useAtom } from "@effect/atom-react";
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { createContext, type ReactNode, use, useState } from "react";
import { setContributionSettingAtom } from "../daemon/atoms";
import { useBoard } from "../features/activity-session";
import type {
  ConfigurationPicture,
  Contribution,
  Workspace,
  WorkspaceId,
} from "../features/configuration-model";
import { configurationPicture } from "../features/configuration-picture";
import { type CustomizePlaces, customizePlaces } from "../features/customize-places";
import { type PluginsView, pluginsView } from "../features/plugins-view";

interface ConfigurationState {
  readonly picture: ConfigurationPicture;
}

interface ConfigurationActions {
  readonly setContributionSetting: (update: ContributionSettingUpdate) => void;
}

interface ConfigurationMeta {
  readonly places: CustomizePlaces;
  readonly plugins: PluginsView;
  readonly contributionById: (id?: string) => Contribution | undefined;
  readonly contributionByFile: (path: string) => Contribution | undefined;
  readonly workspaceById: (id?: WorkspaceId) => Workspace | undefined;
  readonly contributionSettingWaiting: boolean;
}

interface ConfigurationContextValue {
  readonly state: ConfigurationState;
  readonly actions: ConfigurationActions;
  readonly meta: ConfigurationMeta;
}

const ConfigurationContext = createContext<ConfigurationContextValue | null>(null);
const emptyConfigurationPicture: ConfigurationPicture = { workspaces: [], plugins: [], contributions: [] };
const inertConfigurationActions: ConfigurationActions = { setContributionSetting: () => undefined };

interface ContributionSettingSubmission {
  readonly baseline: ControlStore | null;
  readonly update: ContributionSettingUpdate;
  readonly previousResult: AsyncResult.AsyncResult<ControlStore, unknown>;
}

const contributionSettingKey = (cell: ContributionSettingCell) =>
  cell.scope._tag === "SettingsProfile"
    ? `${cell.contribution.id}:settings-profile`
    : `${cell.contribution.id}:private-workspace-overlay:${cell.scope.workspace}`;

const applyContributionSetting = (controlStore: ControlStore | null, update: ContributionSettingUpdate) => {
  if (controlStore === null) return null;
  const cell = update._tag === "Set" ? update.row : update.cell;
  const remaining = controlStore.contributionSettings.filter(
    (row) => contributionSettingKey(row) !== contributionSettingKey(cell),
  );
  const contributionSettings = update._tag === "Set" ? [...remaining, update.row] : remaining;
  return { ...controlStore, contributionSettings };
};

const contributionSettingMatches = (controlStore: ControlStore | null, update: ContributionSettingUpdate) => {
  if (controlStore === null) return false;
  const cell = update._tag === "Set" ? update.row : update.cell;
  const stored = controlStore.contributionSettings.find(
    (row) => contributionSettingKey(row) === contributionSettingKey(cell),
  );
  if (update._tag === "Clear") return stored === undefined;
  return stored?.enabled === update.row.enabled;
};

export const contributionSettingState = (
  board: ControlStore | null,
  result: AsyncResult.AsyncResult<ControlStore, unknown>,
  submission: ContributionSettingSubmission | null,
) => {
  if (submission === null) return { controlStore: board, waiting: result.waiting, settled: false };
  if (board !== submission.baseline && contributionSettingMatches(board, submission.update))
    return { controlStore: board, waiting: result.waiting, settled: true };
  if (result === submission.previousResult)
    return {
      controlStore: applyContributionSetting(board, submission.update),
      waiting: true,
      settled: false,
    };
  if (result._tag === "Failure") return { controlStore: board, waiting: false, settled: true };
  if (result._tag !== "Success" || result.waiting)
    return {
      controlStore: applyContributionSetting(board, submission.update),
      waiting: true,
      settled: false,
    };
  return { controlStore: result.value, waiting: true, settled: false };
};

export function useConfiguration() {
  const value = use(ConfigurationContext);
  if (!value) throw new Error("Configuration readers must render inside a configuration provider");
  return value;
}

const configurationContextValue = (
  picture: ConfigurationPicture,
  actions: ConfigurationActions,
  contributionSettingWaiting: boolean,
): ConfigurationContextValue => ({
  state: { picture },
  actions,
  meta: {
    places: customizePlaces(picture),
    plugins: pluginsView(picture),
    contributionById: (id) => picture.contributions.find((contribution) => contribution.id === id),
    contributionByFile: (path) => picture.contributions.find((contribution) => contribution.file === path),
    workspaceById: (id) => picture.workspaces.find((workspace) => workspace.id === id),
    contributionSettingWaiting,
  },
});

export function StaticConfigurationProvider({
  picture,
  children,
}: {
  picture: ConfigurationPicture;
  children: ReactNode;
}) {
  const value = configurationContextValue(picture, inertConfigurationActions, false);
  return <ConfigurationContext value={value}>{children}</ConfigurationContext>;
}

export function LiveConfigurationProvider({ children }: { children: ReactNode }) {
  const result = useBoard();
  const [write, run] = useAtom(setContributionSettingAtom);
  const [submission, setSubmission] = useState<ContributionSettingSubmission | null>(null);
  const board = result._tag === "Success" ? result.board : null;
  const settingState = contributionSettingState(board?.controlStore ?? null, write, submission);
  if (settingState.settled) setSubmission(null);
  const picture = board
    ? configurationPicture({ ...board, controlStore: settingState.controlStore })
    : emptyConfigurationPicture;
  const value = configurationContextValue(
    picture,
    {
      setContributionSetting: (update) => {
        setSubmission({ baseline: board?.controlStore ?? null, update, previousResult: write });
        run({ payload: { update } });
      },
    },
    settingState.waiting,
  );
  return <ConfigurationContext value={value}>{children}</ConfigurationContext>;
}

export const Configuration = { StaticProvider: StaticConfigurationProvider };
