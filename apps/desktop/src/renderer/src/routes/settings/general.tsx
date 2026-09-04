import { createFileRoute } from "@tanstack/react-router";
import { PageContainer } from "../../components/page-container";
import { GeneralSettings } from "../../components/settings-general";

export const Route = createFileRoute("/settings/general")({
  component: GeneralSettingsRoute,
});

function GeneralSettingsRoute() {
  return (
    <PageContainer width="readable" className="pt-2">
      <GeneralSettings />
    </PageContainer>
  );
}
