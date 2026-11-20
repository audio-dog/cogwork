import type { WorkflowRecord } from "@cogwork/contracts";
import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { RiNodeTree } from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useWorkflowSession } from "../features/workflow-session";

export function WorkflowGate({
  workflowId,
  children,
}: {
  readonly workflowId: string;
  readonly children: (workflow: WorkflowRecord) => ReactNode;
}) {
  const { state } = useWorkflowSession();
  const workflow = state.workflows.find(({ id }) => id === workflowId);
  if (workflow) return children(workflow);
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
