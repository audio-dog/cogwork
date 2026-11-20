import { createFileRoute } from "@tanstack/react-router";

import { WorkflowCreation } from "../../../components/workflows-list";

export const Route = createFileRoute("/_app/workflows/new")({
  component: NewWorkflowRoute,
});

function NewWorkflowRoute() {
  return <WorkflowCreation />;
}
