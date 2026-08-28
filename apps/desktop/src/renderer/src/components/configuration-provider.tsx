import { useAtom, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { createContext, type ReactNode, use, useState } from "react";
import { installPluginAtom, pluginsAtom, uninstallPluginAtom } from "../daemon/atoms";
import { useBoard } from "../features/activity-session";
import type {
  ConfigurationPicture,
  Contribution,
  Workspace,
  WorkspaceId,
} from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
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

interface ConfigurationMeta {
  readonly places: CustomizePlaces;
  readonly plugins: PluginsView;
  readonly contributionById: (id?: string) => Contribution | undefined;
  readonly workspaceById: (id?: WorkspaceId) => Workspace | undefined;
  readonly notices: readonly string[];
  readonly pluginFailure: PluginFailurePresentation | null;
  readonly pluginLoadState: PluginLoadState;
}

interface ConfigurationActions {
  readonly installPlugin: (pluginId: string) => void;
  readonly uninstallPlugin: (pluginId: string) => void;
}

interface ConfigurationContextValue {
  readonly state: ConfigurationState;
  readonly actions: ConfigurationActions;
  readonly meta: ConfigurationMeta;
}

const ConfigurationContext = createContext<ConfigurationContextValue | null>(null);

export function useConfiguration() {
  const value = use(ConfigurationContext);
  if (!value) throw new Error("Configuration readers must render inside a configuration provider");
  return value;
}

function ConfigurationProvider({
  picture,
  actions,
  notices = [],
  pluginFailure = null,
  pluginLoadState = "ready",
  children,
}: {
  picture: ConfigurationPicture;
  actions?: ConfigurationActions;
  notices?: readonly string[];
  pluginFailure?: PluginFailurePresentation | null;
  pluginLoadState?: PluginLoadState;
  children: ReactNode;
}) {
  const unavailableActions: ConfigurationActions = {
    installPlugin: () => undefined,
    uninstallPlugin: () => undefined,
  };
  const value: ConfigurationContextValue = {
    state: { picture },
    actions: actions ?? unavailableActions,
    meta: {
      places: customizePlaces(picture),
      plugins: pluginsView(picture),
      contributionById: (id) => picture.contributions.find((contribution) => contribution.id === id),
      workspaceById: (id) => picture.workspaces.find((workspace) => workspace.id === id),
      notices,
      pluginFailure,
      pluginLoadState,
    },
  };

  return <ConfigurationContext value={value}>{children}</ConfigurationContext>;
}

export function PlaceholderConfigurationProvider({ children }: { children: ReactNode }) {
  return <ConfigurationProvider picture={placeholderConfiguration}>{children}</ConfigurationProvider>;
}

export function DaemonConfigurationProvider({ children }: { children: ReactNode }) {
  const boardResult = useBoard();
  const pluginQuery = useAtomValue(pluginsAtom);
  const [installResult, install] = useAtom(installPluginAtom);
  const [uninstallResult, uninstall] = useAtom(uninstallPluginAtom);
  const [operation, setOperation] = useState<"install" | "uninstall" | null>(null);
  const board = boardResult._tag === "Success" ? boardResult.board : null;
  const activeResult = operation === "install" ? installResult : uninstallResult;
  const { loadState, notices, overview } = pluginSurfaceOf(board, pluginQuery);
  const queryFailure = pluginQueryFailure(pluginQuery);
  const mutationFailure = activeResult._tag === "Failure" ? activeResult.cause : null;
  const pluginFailure = pluginFailureOf(mutationFailure, queryFailure);
  const picture = configurationWithPlugins(placeholderConfiguration, overview, board?.controlStore ?? null);
  const actions: ConfigurationActions = {
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
      notices={notices}
      pluginFailure={pluginFailure}
      pluginLoadState={loadState}
    >
      {children}
    </ConfigurationProvider>
  );
}

export const Configuration = { Provider: ConfigurationProvider };
