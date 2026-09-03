import type {
  Board,
  ContributionSettingCell,
  ContributionSettingUpdate,
  ControlStore,
} from "@cogwork/contracts";
import { useAtom, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
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

export type PluginFailurePresentation =
  | { readonly _tag: "Load"; readonly message: string }
  | { readonly _tag: "Mutation"; readonly message: string };

export const pluginFailureTitle = (failure: PluginFailurePresentation) =>
  failure._tag === "Load" ? "Plugins failed to load" : "Plugin change failed";

const pluginFailureOf = (
  mutationFailure: Cause.Cause<unknown> | null,
  queryFailure: Cause.Cause<unknown> | null,
) => {
  if (mutationFailure)
    return { _tag: "Mutation", message: Cause.pretty(mutationFailure) } satisfies PluginFailurePresentation;
  if (queryFailure)
    return { _tag: "Load", message: Cause.pretty(queryFailure) } satisfies PluginFailurePresentation;
  return null;
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

export const retainConfigurationBoard = (board: Board | null, result: BoardResult) =>
  BoardResult.$match(result, {
    Initial: () => board,
    Failure: () => board,
    Success: ({ board: current }) => current,
  });

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

export function StaticConfigurationProvider({
  picture,
  children,
}: {
  picture: ConfigurationPicture;
  children: ReactNode;
}) {
  return <ConfigurationProvider picture={picture}>{children}</ConfigurationProvider>;
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
  StaticProvider: StaticConfigurationProvider,
};
