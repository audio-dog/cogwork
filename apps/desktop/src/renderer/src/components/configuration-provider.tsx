import { createContext, type ReactNode, use, useMemo } from "react";
import type {
  ConfigurationPicture,
  Contribution,
  Workspace,
  WorkspaceId,
} from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { type CustomizePlaces, customizePlaces } from "../features/customize-places";
import { type PluginsView, pluginsView } from "../features/plugins-view";

interface ConfigurationState {
  readonly picture: ConfigurationPicture;
}

interface ConfigurationMeta {
  readonly places: CustomizePlaces;
  readonly plugins: PluginsView;
  readonly contributionById: (id?: string) => Contribution | undefined;
  readonly workspaceById: (id?: WorkspaceId) => Workspace | undefined;
}

interface ConfigurationContextValue {
  readonly state: ConfigurationState;
  readonly meta: ConfigurationMeta;
}

const ConfigurationContext = createContext<ConfigurationContextValue | null>(null);

export function useConfiguration() {
  const value = use(ConfigurationContext);
  if (!value) throw new Error("Configuration readers must render inside a configuration provider");
  return value;
}

/**
 * The one place that knows where the configuration comes from. Every reader below takes the picture
 * from here, so swapping the fixture for the daemon's answer is a change to this file alone.
 */
function ConfigurationProvider({
  picture,
  children,
}: {
  picture: ConfigurationPicture;
  children: ReactNode;
}) {
  const value = useMemo<ConfigurationContextValue>(
    () => ({
      state: { picture },
      meta: {
        places: customizePlaces(picture),
        plugins: pluginsView(picture),
        contributionById: (id) => picture.contributions.find((contribution) => contribution.id === id),
        workspaceById: (id) => picture.workspaces.find((workspace) => workspace.id === id),
      },
    }),
    [picture],
  );

  return <ConfigurationContext value={value}>{children}</ConfigurationContext>;
}

/** Nothing here talks to the Engine yet. The fixture is a provider, not an import in every leaf. */
export function PlaceholderConfigurationProvider({ children }: { children: ReactNode }) {
  return <ConfigurationProvider picture={placeholderConfiguration}>{children}</ConfigurationProvider>;
}

export const Configuration = { Provider: ConfigurationProvider };
