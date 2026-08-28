import type { ContributionSettingUpdate } from "@cogwork/contracts";
import { useAtom } from "@effect/atom-react";
import { createContext, type ReactNode, use } from "react";
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
  const picture = result._tag === "Success" ? configurationPicture(result.board) : emptyConfigurationPicture;
  const value = configurationContextValue(
    picture,
    { setContributionSetting: (update) => run({ payload: { update } }) },
    write.waiting,
  );
  return <ConfigurationContext value={value}>{children}</ConfigurationContext>;
}

export const Configuration = { StaticProvider: StaticConfigurationProvider };
