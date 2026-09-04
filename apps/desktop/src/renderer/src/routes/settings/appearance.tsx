import { createFileRoute } from "@tanstack/react-router";
import { PageContainer } from "../../components/page-container";
import { AppearanceSettings } from "../../components/settings-appearance";

export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSettingsRoute,
});

function AppearanceSettingsRoute() {
  return (
    <PageContainer width="readable" className="pt-2">
      <AppearanceSettings />
    </PageContainer>
  );
}
