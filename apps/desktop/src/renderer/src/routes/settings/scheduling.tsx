import { createFileRoute } from "@tanstack/react-router";
import { PageContainer } from "../../components/page-container";
import { SchedulingSettings } from "../../components/settings-scheduling";

export const Route = createFileRoute("/settings/scheduling")({
  component: SchedulingSettingsRoute,
});

function SchedulingSettingsRoute() {
  return (
    <PageContainer width="readable" className="pt-2">
      <SchedulingSettings />
    </PageContainer>
  );
}
