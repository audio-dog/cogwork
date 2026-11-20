import { createFileRoute } from "@tanstack/react-router";

import { WorkflowEditor } from "../../../components/workflow-editor";
import { WorkflowGate } from "../../../components/workflow-gate";

export const Route = createFileRoute("/_app/workflows/$workflowId")({
  component: WorkflowRoute,
});

function WorkflowRoute() {
  const { workflowId } = Route.useParams();
  return (
    <WorkflowGate workflowId={workflowId}>
      {(workflow) => <WorkflowEditor key={workflowId} workflow={workflow} />}
    </WorkflowGate>
  );
}
