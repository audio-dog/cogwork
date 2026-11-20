import { createFileRoute, Outlet } from "@tanstack/react-router";

import { useConfiguration } from "../../../components/configuration-provider";
import { CustomizeFilterProvider } from "../../../components/customize-filter";

export const Route = createFileRoute("/_app/customize")({
  component: CustomizeLayout,
});

function CustomizeLayout() {
  const {
    meta: { places },
  } = useConfiguration();
  return (
    // This layout outlives a drill-in to a Plugin, so the filter state does too.
    <CustomizeFilterProvider key={places.allPlaceKeys.join("|")}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 pt-6 pb-12">
        <Outlet />
      </div>
    </CustomizeFilterProvider>
  );
}
