import { RiNodeTree } from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";
import { PagePlaceholder } from "../../components/page-placeholder";

function WorkflowsPage() {
  return (
    <PagePlaceholder icon={RiNodeTree} title="Workflows">
      Operations, the transitions between them, and the settings that configure each one — harness, model,
      effort, permission profile, and the contributions bound to a declared need. This page also owns the
      question the three-rung Scope ladder left open: which Scopes may hold an Operation setting now that the
      Settings profile rung is gone.
    </PagePlaceholder>
  );
}

export const Route = createFileRoute("/_app/workflows")({
  component: WorkflowsPage,
});
