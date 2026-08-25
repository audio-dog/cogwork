// PROTOTYPE — the shared filter state for Customize.
//
// Every variant filters over the same two axes; only the control differs, which is the whole point
// of the comparison. Keeping the state and the selectors here means a difference on screen is a
// difference in the control and never an accident of the plumbing.

import type { Contribution, ContributionKind, ScopeKind } from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";

export type Facet = "plugins" | ContributionKind;

const { contributions } = placeholderConfiguration;

/** How many contributions are defined at each place. The filter controls all show this. */
export function definedAtCount(scope: ScopeKind, facet: Facet): number {
  return contributions.filter(
    (contribution) =>
      contribution.definedAt === scope && (facet === "plugins" || contribution.kind === facet),
  ).length;
}

export function kindCount(kind: ContributionKind, places: readonly ScopeKind[]): number {
  return contributions.filter(
    (contribution) => contribution.kind === kind && places.includes(contribution.definedAt),
  ).length;
}

export function visibleContributions(
  facet: Facet,
  places: readonly ScopeKind[],
  query: string,
): readonly Contribution[] {
  const needle = query.trim().toLowerCase();
  return contributions
    .filter((contribution) => facet !== "plugins" && contribution.kind === facet)
    .filter((contribution) => places.includes(contribution.definedAt))
    .filter((contribution) =>
      needle === ""
        ? true
        : `${contribution.localName} ${contribution.summary}`.toLowerCase().includes(needle),
    );
}
