import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { RiNodeTree } from "@remixicon/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { WorkflowEditor } from "../../../components/workflow-editor";
import { useWorkflowSession } from "../../../features/workflow-session";

export const Route = createFileRoute("/_app/workflows/$workflowId")({
  component: WorkflowRoute,
});

function WorkflowRoute() {
  const { workflowId } = Route.useParams();
  const { state } = useWorkflowSession();
  const workflow = state.workflows.find(({ id }) => id === workflowId);
  if (workflow) return <WorkflowEditor key={workflowId} workflow={workflow} />;
  if (state.loading)
    return (
      <div className="mx-auto flex w-full max-w-2xl px-8 py-16">
        <Empty className="w-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RiNodeTree />
            </EmptyMedia>
            <EmptyTitle>Loading Workflow</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </div>
    );
  return (
    <div className="mx-auto flex w-full max-w-2xl px-8 py-16">
      <Empty className="w-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RiNodeTree />
          </EmptyMedia>
          <EmptyTitle>Workflow not found</EmptyTitle>
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
