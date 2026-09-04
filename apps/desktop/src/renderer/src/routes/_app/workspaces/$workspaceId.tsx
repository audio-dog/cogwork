import { createFileRoute } from "@tanstack/react-router";
import { PageContainer } from "../../../components/page-container";
import { WorkspaceSettingsPage } from "../../../components/workspace-settings";
import { LiveWorkspacesProvider } from "../../../components/workspaces-provider";

export const Route = createFileRoute("/_app/workspaces/$workspaceId")({
  component: WorkspaceSettingsRoute,
});

function WorkspaceSettingsRoute() {
  const { workspaceId } = Route.useParams();
  return (
    <PageContainer width="standard" className="pt-6">
      <LiveWorkspacesProvider>
        {/* The route reuses one component across params, so the draft dies with the key. */}
        <WorkspaceSettingsPage key={workspaceId} workspaceId={workspaceId} />
      </LiveWorkspacesProvider>
    </PageContainer>
  );
}
