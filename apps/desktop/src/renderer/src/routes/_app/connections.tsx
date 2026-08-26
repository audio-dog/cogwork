import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { RiPlugLine } from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/connections")({
  component: ConnectionsRoute,
});

function ConnectionsRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl px-8 py-16">
      <Empty className="w-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RiPlugLine />
          </EmptyMedia>
          <EmptyTitle>Connections aren't ready yet</EmptyTitle>
          <EmptyDescription>We're still working out what one is.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
