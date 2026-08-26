import {
  type ConfigurationPicture,
  type Contribution,
  type ContributionKind,
  type ScopeKind,
  type ScopeRef,
  scopeCopy,
  scopeKey,
  type WorkspaceId,
} from "./configuration-model";
import { definedScope } from "./configuration-resolve";

export const workspaceScopeKinds: readonly ScopeKind[] = ["workspace-input", "private-overlay"];

export const profilePlace: ScopeRef = { kind: "settings-profile" };

export function placeOf(contribution: Contribution): string {
  return scopeKey(definedScope(contribution));
}

export function toggle(places: readonly string[], key: string): readonly string[] {
  return places.includes(key) ? places.filter((entry) => entry !== key) : [...places, key];
}

export interface ContributionGroup {
  readonly key: string;
  readonly label: string;
  readonly rows: readonly Contribution[];
}

/**
 * The Place axis, bound to one configuration. Every reader takes its picture from the provider, so
 * a fixture and the daemon's own answer are the same shape and neither is imported by a component.
 */
export interface CustomizePlaces {
  readonly allPlaces: readonly ScopeRef[];
  readonly allPlaceKeys: readonly string[];
  readonly placeCount: number;
  readonly countAt: (place: ScopeRef, kind: ContributionKind) => number;
  readonly countInWorkspace: (workspaceId: WorkspaceId, kind: ContributionKind) => number;
  readonly kindCount: (kind: ContributionKind, places: readonly string[]) => number;
  readonly visibleContributions: (
    kind: ContributionKind,
    places: readonly string[],
    query: string,
  ) => readonly Contribution[];
  readonly groupContributions: (
    kind: ContributionKind,
    places: readonly string[],
    query: string,
  ) => readonly ContributionGroup[];
  readonly summarize: (places: readonly string[]) => string;
}

export function customizePlaces(picture: ConfigurationPicture): CustomizePlaces {
  const { contributions, workspaces, plugins } = picture;

  const allPlaces: readonly ScopeRef[] = [
    profilePlace,
    ...workspaces.flatMap((workspace) =>
      workspaceScopeKinds.map((kind) => ({ kind, workspaceId: workspace.id })),
    ),
  ];
  const allPlaceKeys = allPlaces.map(scopeKey);

  const countAt = (place: ScopeRef, kind: ContributionKind) => {
    const key = scopeKey(place);
    return contributions.filter((contribution) => placeOf(contribution) === key && contribution.kind === kind)
      .length;
  };

  const countInWorkspace = (workspaceId: WorkspaceId, kind: ContributionKind) =>
    workspaceScopeKinds.reduce(
      (total, scopeKind) => total + countAt({ kind: scopeKind, workspaceId }, kind),
      0,
    );

  const kindCount = (kind: ContributionKind, places: readonly string[]) =>
    contributions.filter(
      (contribution) => contribution.kind === kind && places.includes(placeOf(contribution)),
    ).length;

  const visibleContributions = (kind: ContributionKind, places: readonly string[], query: string) => {
    const needle = query.trim().toLowerCase();
    return contributions
      .filter((contribution) => contribution.kind === kind)
      .filter((contribution) => places.includes(placeOf(contribution)))
      .filter((contribution) =>
        needle === ""
          ? true
          : `${contribution.localName} ${contribution.summary}`.toLowerCase().includes(needle),
      );
  };

  const groupContributions = (kind: ContributionKind, places: readonly string[], query: string) => {
    const visible = visibleContributions(kind, places, query);

    const mine = visible.filter(
      (contribution) => contribution.authority._tag === "local" && contribution.authority.tree === "user",
    );
    const builtIn = visible.filter((contribution) => contribution.authority._tag === "engine");

    const fromPlugins = [...plugins]
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((plugin) => ({
        key: `plugin:${plugin.record.pluginId}`,
        label: plugin.name,
        rows: visible.filter(
          (contribution) =>
            contribution.authority._tag === "plugin" &&
            contribution.authority.pluginId === plugin.record.pluginId,
        ),
      }));

    const inRepos = allPlaces
      .filter((place) => place.workspaceId !== undefined)
      .map((place) => {
        const key = scopeKey(place);
        const workspace = workspaces.find((entry) => entry.id === place.workspaceId);
        return {
          key,
          label: `${workspace?.name ?? "Unknown"} · ${scopeCopy[place.kind].name}`,
          rows: visible.filter(
            (contribution) => contribution.authority._tag !== "plugin" && placeOf(contribution) === key,
          ),
        };
      });

    return [
      { key: "settings-profile", label: scopeCopy["settings-profile"].name, rows: mine },
      { key: "engine", label: "Built in", rows: builtIn },
      ...fromPlugins,
      ...inRepos,
    ].filter((group) => group.rows.length > 0);
  };

  const summarize = (places: readonly string[]) => {
    if (places.length === 0) return "Nothing selected";
    if (places.length === allPlaceKeys.length) return "Everywhere";

    const groups: string[] = [];
    if (places.includes(scopeKey(profilePlace))) groups.push(scopeCopy["settings-profile"].name);
    for (const workspace of workspaces) {
      const keys = workspaceScopeKinds.map((kind) => scopeKey({ kind, workspaceId: workspace.id }));
      if (keys.some((key) => places.includes(key))) groups.push(workspace.name);
    }

    const [first, ...rest] = groups;
    if (first === undefined) return "Nothing selected";
    return rest.length === 0 ? first : `${first} +${rest.length}`;
  };

  return {
    allPlaces,
    allPlaceKeys,
    placeCount: allPlaceKeys.length,
    countAt,
    countInWorkspace,
    kindCount,
    visibleContributions,
    groupContributions,
    summarize,
  };
}
