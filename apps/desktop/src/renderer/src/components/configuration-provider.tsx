import {
  type Board,
  type ContributionSettingCell,
  ContributionSettingScope,
  ContributionSettingUpdate,
  type ControlStore,
} from "@cogwork/contracts";
import { useAtom, useAtomValue } from "@effect/atom-react";
import type * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import type * as AsyncResult from "effect/reactivity/AsyncResult";
import { createContext, type ReactNode, use, useState } from "react";
import {
  installPluginAtom,
  pluginsAtom,
  setContributionSettingAtom,
  uninstallPluginAtom,
} from "../daemon/atoms";
import { BoardResult, useBoard } from "../features/activity-session";
import type {
  ConfigurationPicture,
  Contribution,
  Workspace,
  WorkspaceId,
} from "../features/configuration-model";
import { configurationPicture } from "../features/configuration-picture";
import { type CustomizePlaces, customizePlaces } from "../features/customize-places";
import { daemonFailureMessage } from "../features/daemon-failure";
import {
  configurationWithPlugins,
  type PluginLoadState,
  pluginQueryFailure,
  pluginSurfaceOf,
} from "../features/plugin-configuration";
import { type PluginsView, pluginsView } from "../features/plugins-view";

interface ConfigurationState {
  readonly picture: ConfigurationPicture;
}

export type PluginFailurePresentation = Data.TaggedEnum<{
  Load: { readonly message: string };
  Mutation: { readonly message: string };
}>;

export const PluginFailurePresentation = Data.taggedEnum<PluginFailurePresentation>();

export const pluginFailureTitle = (failure: PluginFailurePresentation) =>
  PluginFailurePresentation.$match(failure, {
    Load: () => "Plugins failed to load",
    Mutation: () => "Plugin change failed",
  });

const pluginFailureOf = (
  mutationFailure: Cause.Cause<unknown> | null,
  queryFailure: Cause.Cause<unknown> | null,
) => {
  const failure = [
    { cause: mutationFailure, present: PluginFailurePresentation.Mutation },
    { cause: queryFailure, present: PluginFailurePresentation.Load },
  ].find(({ cause }) => cause !== null);
  if (!failure?.cause) return null;
  return failure.present({ message: daemonFailureMessage(failure.cause) });
};

interface ConfigurationActions {
  readonly setContributionSetting: (update: ContributionSettingUpdate) => void;
  readonly installPlugin: (pluginId: string) => void;
  readonly uninstallPlugin: (pluginId: string) => void;
}

interface ConfigurationMeta {
  readonly places: CustomizePlaces;
  readonly plugins: PluginsView;
  readonly contributionById: (id?: string) => Contribution | undefined;
  readonly contributionByFile: (path: string) => Contribution | undefined;
  readonly workspaceById: (id?: WorkspaceId) => Workspace | undefined;
  readonly contributionSettingWaiting: boolean;
  readonly notices: readonly string[];
  readonly pluginFailure: PluginFailurePresentation | null;
  readonly pluginLoadState: PluginLoadState;
}

interface ConfigurationContextValue {
  readonly state: ConfigurationState;
  readonly actions: ConfigurationActions;
  readonly meta: ConfigurationMeta;
}

const ConfigurationContext = createContext<ConfigurationContextValue | null>(null);
const emptyConfigurationPicture: ConfigurationPicture = {
  workspaces: [],
  plugins: [],
  catalogPlugins: [],
  contributions: [],
};
const inertConfigurationActions: ConfigurationActions = {
  setContributionSetting: () => undefined,
  installPlugin: () => undefined,
  uninstallPlugin: () => undefined,
};

interface ContributionSettingSubmission {
  readonly baseline: ControlStore | null;
  readonly update: ContributionSettingUpdate;
  readonly previousResult: AsyncResult.AsyncResult<ControlStore, unknown>;
}

const contributionSettingKey = (cell: ContributionSettingCell) =>
  ContributionSettingScope.match(cell.scope, {
    SettingsProfile: () => `${cell.contribution.id}:settings-profile`,
    PrivateWorkspaceOverlay: ({ workspace }) =>
      `${cell.contribution.id}:private-workspace-overlay:${workspace}`,
  });

const contributionSettingCell = (update: ContributionSettingUpdate) =>
  ContributionSettingUpdate.match(update, {
    Set: ({ row }) => row,
    Clear: ({ cell }) => cell,
  });

const applyContributionSetting = (controlStore: ControlStore | null, update: ContributionSettingUpdate) => {
  if (controlStore === null) return null;
  const cell = contributionSettingCell(update);
  const remaining = controlStore.contributionSettings.filter(
    (row) => contributionSettingKey(row) !== contributionSettingKey(cell),
  );
  const contributionSettings = ContributionSettingUpdate.match(update, {
    Set: ({ row }) => [...remaining, row],
    Clear: () => remaining,
  });
  return { ...controlStore, contributionSettings };
};

const contributionSettingMatches = (controlStore: ControlStore | null, update: ContributionSettingUpdate) => {
  if (controlStore === null) return false;
  const cell = contributionSettingCell(update);
  const stored = controlStore.contributionSettings.find(
    (row) => contributionSettingKey(row) === contributionSettingKey(cell),
  );
  return ContributionSettingUpdate.match(update, {
    Set: ({ row }) => stored?.enabled === row.enabled,
    Clear: () => stored === undefined,
  });
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

export const retainConfigurationBoard = (board: Board | null, result: BoardResult) =>
  BoardResult.$is("Success")(result) ? result.board : board;

export function useConfiguration() {
  const value = use(ConfigurationContext);
  if (!value) throw new Error("Configuration readers must render inside a configuration provider");
  return value;
}

function ConfigurationProvider({
  picture,
  actions = inertConfigurationActions,
  contributionSettingWaiting = false,
  notices = [],
  pluginFailure = null,
  pluginLoadState = "ready",
  children,
}: {
  picture: ConfigurationPicture;
  actions?: ConfigurationActions;
  contributionSettingWaiting?: boolean;
  notices?: readonly string[];
  pluginFailure?: PluginFailurePresentation | null;
  pluginLoadState?: PluginLoadState;
  children: ReactNode;
}) {
  const value: ConfigurationContextValue = {
    state: { picture },
    actions,
    meta: {
      places: customizePlaces(picture),
      plugins: pluginsView(picture),
      contributionById: (id) => picture.contributions.find((contribution) => contribution.id === id),
      contributionByFile: (path) => picture.contributions.find((contribution) => contribution.file === path),
      workspaceById: (id) => picture.workspaces.find((workspace) => workspace.id === id),
      contributionSettingWaiting,
      notices,
      pluginFailure,
      pluginLoadState,
    },
  };
  return <ConfigurationContext value={value}>{children}</ConfigurationContext>;
}

export function DaemonConfigurationProvider({ children }: { children: ReactNode }) {
  const boardResult = useBoard();
  const pluginQuery = useAtomValue(pluginsAtom);
  const [settingResult, setContributionSetting] = useAtom(setContributionSettingAtom);
  const [installResult, install] = useAtom(installPluginAtom);
  const [uninstallResult, uninstall] = useAtom(uninstallPluginAtom);
  const [submission, setSubmission] = useState<ContributionSettingSubmission | null>(null);
  const [operation, setOperation] = useState<"install" | "uninstall" | null>(null);
  const [retainedBoard, setRetainedBoard] = useState<Board | null>(() =>
    retainConfigurationBoard(null, boardResult),
  );
  const board = retainConfigurationBoard(retainedBoard, boardResult);
  if (board !== retainedBoard) setRetainedBoard(board);
  const settingState = contributionSettingState(board?.controlStore ?? null, settingResult, submission);
  if (settingState.settled) setSubmission(null);
  const activeResult = operation === "install" ? installResult : uninstallResult;
  const { loadState, notices, overview } = pluginSurfaceOf(board, pluginQuery);
  const queryFailure = pluginQueryFailure(pluginQuery);
  const mutationFailure = activeResult._tag === "Failure" ? activeResult.cause : null;
  const pluginFailure = pluginFailureOf(mutationFailure, queryFailure);
  const localPicture = board
    ? configurationPicture({ ...board, controlStore: settingState.controlStore })
    : emptyConfigurationPicture;
  const picture = configurationWithPlugins(localPicture, overview, settingState.controlStore);
  const actions: ConfigurationActions = {
    setContributionSetting: (update) => {
      setSubmission({ baseline: board?.controlStore ?? null, update, previousResult: settingResult });
      setContributionSetting({ payload: { update } });
    },
    installPlugin: (pluginId) => {
      setOperation("install");
      install({ payload: { pluginId } });
    },
    uninstallPlugin: (pluginId) => {
      setOperation("uninstall");
      uninstall({ payload: { pluginId } });
    },
  };
  return (
    <ConfigurationProvider
      picture={picture}
      actions={actions}
      contributionSettingWaiting={settingState.waiting || !BoardResult.$is("Success")(boardResult)}
      notices={notices}
      pluginFailure={pluginFailure}
      pluginLoadState={loadState}
    >
      {children}
    </ConfigurationProvider>
  );
}

export const Configuration = {
  Provider: ConfigurationProvider,
};
