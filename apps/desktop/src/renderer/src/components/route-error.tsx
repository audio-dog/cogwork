import { Button } from "@cogwork/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@cogwork/ui/components/empty";
import { RiErrorWarningLine, RiRefreshLine } from "@remixicon/react";
import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";

// Boundary for in-app render and loader failures. A GPU/renderer *process* crash disposes the whole
// frame and is recovered by the main process (window.ts) instead — this catches errors thrown while
// React is still alive.
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();

  const retry = () => {
    reset();
    router.invalidate();
  };

  return (
    <div className="p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RiErrorWarningLine />
          </EmptyMedia>
          <EmptyTitle>Something went wrong</EmptyTitle>
          <EmptyDescription>{error.message}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={retry}>
            <RiRefreshLine data-icon="inline-start" />
            Try again
          </Button>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
