import { createFileRoute, redirect } from "@tanstack/react-router";

import {
  ContributionFacetView,
  HooksFacetView,
  McpServersFacetView,
  PluginsFacetView,
} from "../../../components/customize-facet-view";
import { defaultFacet, type Facet, facetFromSlug, facetSlug } from "../../../features/customize-facets";

export const Route = createFileRoute("/_app/customize/$facet")({
  beforeLoad: ({ params }) => {
    if (facetFromSlug(params.facet)) return;
    throw redirect({ to: "/customize/$facet", params: { facet: facetSlug(defaultFacet) } });
  },
  component: CustomizeFacetRoute,
});

function facetView(facet: Facet) {
  if (facet === "plugins") return <PluginsFacetView />;
  if (facet === "mcp-server") return <McpServersFacetView />;
  if (facet === "hook") return <HooksFacetView />;
  return <ContributionFacetView kind={facet} />;
}

function CustomizeFacetRoute() {
  const facet = facetFromSlug(Route.useParams().facet);
  if (!facet) return null;
  return facetView(facet);
}
