import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { RiNodeTree } from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/workflows")({
  component: WorkflowsRoute,
});

function WorkflowsRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl px-8 py-16">
      <Empty className="w-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RiNodeTree />
          </EmptyMedia>
          <EmptyTitle>Workflows aren't ready yet</EmptyTitle>
          <EmptyDescription>Operations and their settings will live here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
