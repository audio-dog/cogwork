import { createFileRoute } from "@tanstack/react-router";

import { ConnectionsSurface } from "../../components/connections-surface";

export const Route = createFileRoute("/_app/connections")({
  component: ConnectionsRoute,
});

function ConnectionsRoute() {
  return (
    <div className="mx-auto w-full max-w-5xl px-8 pt-6 pb-12">
      <ConnectionsSurface />
    </div>
  );
}
