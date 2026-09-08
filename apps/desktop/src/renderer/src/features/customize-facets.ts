import { type ContributionKind, contributionKinds, kindLabelsPlural } from "./configuration-model";

export type Facet = "plugins" | ContributionKind;

const slugs: Record<Facet, string> = {
  plugins: "plugins",
  "mcp-server": "mcp-servers",
  skill: "skills",
  subagent: "subagents",
  rules: "rules",
  command: "commands",
  hook: "hooks",
};

export const facets: readonly Facet[] = ["plugins", ...contributionKinds];

export const defaultFacet: Facet = "plugins";

export function facetSlug(facet: Facet) {
  return slugs[facet];
}

export function facetFromSlug(slug: string) {
  return facets.find((facet) => slugs[facet] === slug);
}

export function facetLabel(facet: Facet) {
  if (facet === "plugins") return "Plugins";
  return kindLabelsPlural[facet];
}
