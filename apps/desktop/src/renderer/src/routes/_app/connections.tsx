import { createFileRoute } from "@tanstack/react-router";
import { ConnectionsSurface } from "../../components/connections-surface";
import { PageContainer } from "../../components/page-container";

export const Route = createFileRoute("/_app/connections")({
  component: ConnectionsRoute,
});

function ConnectionsRoute() {
  return (
    <PageContainer width="wide" className="pt-6">
      <ConnectionsSurface />
    </PageContainer>
  );
}
