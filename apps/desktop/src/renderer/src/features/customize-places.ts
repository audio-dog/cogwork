// PROTOTYPE — the set of places a contribution can live, and the filter over them.
//
// A place is fully named or it is not a place: "the repository" means nothing until you say which
// repository, and two of these workspaces share one git remote. So a place key is either
// `runtime-host` or a Scope kind paired with a WorkspaceId — which is exactly `scopeKey`.
//
// Naming the workspace inside the place is what removes the separate workspace picker every earlier
// variant needed underneath its level control.

import {
  type Contribution,
  type ContributionKind,
  type ScopeKind,
  type ScopeRef,
  scopeCopy,
  scopeKey,
} from "./configuration-model";
import { placeholderConfiguration } from "./configuration-placeholder";
import { definedScope } from "./configuration-resolve";

export type Facet = "plugins" | ContributionKind;

const { contributions, workspaces } = placeholderConfiguration;

export const workspaceScopeKinds: readonly ScopeKind[] = ["workspace-input", "private-overlay"];

export const machinePlace: ScopeRef = { kind: "runtime-host" };

/** Every place on this machine, machine first and then each workspace's two. */
export const allPlaces: readonly ScopeRef[] = [
  machinePlace,
  ...workspaces.flatMap((workspace) =>
    workspaceScopeKinds.map((kind) => ({ kind, workspaceId: workspace.id })),
  ),
];

export const allPlaceKeys: readonly string[] = allPlaces.map(scopeKey);

export function placeOf(contribution: Contribution): string {
  return scopeKey(definedScope(contribution));
}

export function countAt(place: ScopeRef, facet: Facet): number {
  const key = scopeKey(place);
  return contributions.filter(
    (contribution) => placeOf(contribution) === key && (facet === "plugins" || contribution.kind === facet),
  ).length;
}

export function kindCount(kind: ContributionKind, places: readonly string[]): number {
  return contributions.filter(
    (contribution) => contribution.kind === kind && places.includes(placeOf(contribution)),
  ).length;
}

export function visibleContributions(
  facet: Facet,
  places: readonly string[],
  query: string,
): readonly Contribution[] {
  const needle = query.trim().toLowerCase();
  return contributions
    .filter((contribution) => facet !== "plugins" && contribution.kind === facet)
    .filter((contribution) => places.includes(placeOf(contribution)))
    .filter((contribution) =>
      needle === ""
        ? true
        : `${contribution.localName} ${contribution.summary}`.toLowerCase().includes(needle),
    );
}

export function toggle(places: readonly string[], key: string): readonly string[] {
  return places.includes(key) ? places.filter((entry) => entry !== key) : [...places, key];
}

/**
 * What the trigger says: the scope of what is on screen, named the way Cursor names it — the first
 * selected group, then a `+n` for the rest.
 *
 * Groups, not places: "cogwork" covers both of that workspace's places, because a person thinks in
 * workspaces and reads a count of them, not a count of Scopes.
 */
export function summarize(places: readonly string[]): string {
  if (places.length === 0) return "Nothing selected";
  if (places.length === allPlaceKeys.length) return "Everywhere";

  const groups: string[] = [];
  if (places.includes(scopeKey(machinePlace))) groups.push(scopeCopy["runtime-host"].name);
  for (const workspace of workspaces) {
    const keys = workspaceScopeKinds.map((kind) => scopeKey({ kind, workspaceId: workspace.id }));
    if (keys.some((key) => places.includes(key))) groups.push(workspace.name);
  }

  const [first, ...rest] = groups;
  if (first === undefined) return "Nothing selected";
  return rest.length === 0 ? first : `${first} +${rest.length}`;
}

/** How many places exist, for a menu footer that reports the selection honestly. */
export const placeCount = allPlaceKeys.length;
