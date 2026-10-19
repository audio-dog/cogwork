import { Button } from "@cogwork/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@cogwork/ui/components/empty";
import { RiNodeTree } from "@remixicon/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { WorkflowEditor } from "../../../components/workflow-editor";
import { mockWorkflow } from "../../../features/workflow-mock-data";

export const Route = createFileRoute("/_app/workflows/$workflowId")({
  component: WorkflowRoute,
});

function WorkflowRoute() {
  const { workflowId } = Route.useParams();
  const workflow = mockWorkflow(workflowId);
  if (!workflow) {
    return (
      <div className="mx-auto flex w-full max-w-2xl px-8 py-16">
        <Empty className="w-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RiNodeTree />
            </EmptyMedia>
            <EmptyTitle>Workflow not found</EmptyTitle>
            <EmptyDescription>It may have been removed.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/workflows" />}>
              Back to Workflows
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }
  // The route reuses one component across params, so the draft dies with the key.
  return <WorkflowEditor key={workflowId} workflow={workflow} />;
}
