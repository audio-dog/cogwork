import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceSettingsPage } from "../../../components/workspace-settings";
import { LiveWorkspacesProvider } from "../../../components/workspaces-provider";

export const Route = createFileRoute("/_app/workspaces/$workspaceId")({
  component: WorkspaceSettingsRoute,
});

function WorkspaceSettingsRoute() {
  const { workspaceId } = Route.useParams();
  return (
    <LiveWorkspacesProvider>
      {/* The route reuses one component across params, so the draft dies with the key. */}
      <WorkspaceSettingsPage key={workspaceId} workspaceId={workspaceId} />
    </LiveWorkspacesProvider>
  );
}
