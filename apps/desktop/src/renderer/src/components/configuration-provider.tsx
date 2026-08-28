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
  pluginQueryFailure,
  pluginSurfaceOf,
} from "../features/plugin-configuration";
import { type PluginsView, pluginsView } from "../features/plugins-view";

interface ConfigurationState {
  readonly picture: ConfigurationPicture;
}

interface ConfigurationMeta {
  readonly places: CustomizePlaces;
  readonly plugins: PluginsView;
  readonly contributionById: (id?: string) => Contribution | undefined;
  readonly workspaceById: (id?: WorkspaceId) => Workspace | undefined;
  readonly notices: readonly string[];
  readonly pluginFailure: string | null;
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
  children,
}: {
  picture: ConfigurationPicture;
  actions?: ConfigurationActions;
  notices?: readonly string[];
  pluginFailure?: string | null;
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
  const { overview, notices } = pluginSurfaceOf(board, pluginQuery);
  const queryFailure = pluginQueryFailure(pluginQuery);
  const pluginFailureCause = activeResult._tag === "Failure" ? activeResult.cause : queryFailure;
  const pluginFailure = pluginFailureCause ? Cause.pretty(pluginFailureCause) : null;
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
    >
      {children}
    </ConfigurationProvider>
  );
}

export const Configuration = { Provider: ConfigurationProvider };
