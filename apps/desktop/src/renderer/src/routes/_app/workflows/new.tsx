import { createFileRoute } from "@tanstack/react-router";
import { WorkflowEditor } from "../../../components/workflow-editor";
import { untitledWorkflow } from "../../../features/workflow-mock-data";

export const Route = createFileRoute("/_app/workflows/new")({
  component: NewWorkflowRoute,
});

function NewWorkflowRoute() {
  return <WorkflowEditor workflow={untitledWorkflow} />;
}
