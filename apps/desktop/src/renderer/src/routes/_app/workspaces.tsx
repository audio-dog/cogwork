import { createFileRoute } from "@tanstack/react-router";
import { Workspaces } from "../../components/workspaces-surface";

export const Route = createFileRoute("/_app/workspaces")({
  component: WorkspacesRoute,
});

function WorkspacesRoute() {
  return (
    <Workspaces.LiveProvider>
      <Workspaces.Root>
        <Workspaces.Header />
        <Workspaces.Registry />
        <Workspaces.Limits />
      </Workspaces.Root>
    </Workspaces.LiveProvider>
  );
}
