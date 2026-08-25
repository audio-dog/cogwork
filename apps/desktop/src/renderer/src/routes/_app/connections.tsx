import { RiPlugLine } from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";
import { PagePlaceholder } from "../../components/page-placeholder";

function ConnectionsPage() {
  return (
    <PagePlaceholder icon={RiPlugLine} title="Connections">
      Deliberately empty. `Connection` is marked provisional in the glossary — what one *is* depends on
      whether a first-party integration stays an engine-owned port or becomes something a person installs and
      authenticates, which is #172 — and its establishment, health, refresh, and revocation are still open.
      Giving it a page fixes where it lands without designing it.
    </PagePlaceholder>
  );
}

export const Route = createFileRoute("/_app/connections")({
  component: ConnectionsPage,
});
