import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { WorkflowEditor } from "../../../components/workflow-editor";
import { WorkflowGate } from "../../../components/workflow-gate";
import { importReviewMarks } from "../../../features/workflow-import-review";

export const Route = createFileRoute("/_app/workflows/$workflowId_/review")({
  component: WorkflowImportReviewRoute,
});

function WorkflowImportReviewRoute() {
  const { workflowId } = Route.useParams();
  const navigate = useNavigate();
  return (
    <WorkflowGate workflowId={workflowId}>
      {(workflow) => (
        <WorkflowEditor
          key={workflowId}
          workflow={workflow}
          importReview={importReviewMarks(workflow.workingCopy)}
          onPublished={() =>
            navigate({ to: "/workflows/$workflowId", params: { workflowId }, replace: true })
          }
        />
      )}
    </WorkflowGate>
  );
}
