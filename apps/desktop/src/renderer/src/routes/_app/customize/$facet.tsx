import { createFileRoute, redirect } from "@tanstack/react-router";
import { CustomizeFacetView } from "../../../components/customize-facet-view";
import { defaultFacet, facetFromSlug, facetSlug } from "../../../features/customize-facets";

export const Route = createFileRoute("/_app/customize/$facet")({
  beforeLoad: ({ params }) => {
    if (facetFromSlug(params.facet)) return;
    throw redirect({ to: "/customize/$facet", params: { facet: facetSlug(defaultFacet) } });
  },
  component: CustomizeFacetRoute,
});

function CustomizeFacetRoute() {
  const facet = facetFromSlug(Route.useParams().facet);
  if (!facet) return null;
  return <CustomizeFacetView facet={facet} />;
}
