import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useConfiguration } from "../../../components/configuration-provider";
import { CustomizeFilterProvider } from "../../../components/customize-filter";
import { PageContainer } from "../../../components/page-container";

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
      <PageContainer width="wide" className="flex flex-col gap-6 pt-6">
        <Outlet />
      </PageContainer>
    </CustomizeFilterProvider>
  );
}
