import { createFileRoute, redirect } from "@tanstack/react-router";

import { defaultFacet, facetSlug } from "../../../features/customize-facets";

export const Route = createFileRoute("/_app/customize/")({
  beforeLoad: () => {
    throw redirect({ to: "/customize/$facet", params: { facet: facetSlug(defaultFacet) } });
  },
});
