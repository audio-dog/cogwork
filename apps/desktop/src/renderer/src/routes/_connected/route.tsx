import { Alert, AlertDescription, AlertTitle } from "@clanker-forge/ui/components/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@clanker-forge/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@clanker-forge/ui/components/empty";
import { createFileRoute, Outlet, useMatches } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { EngineOfflineMessage } from "../../features/engine-offline";
import { useBoard } from "../../features/use-board";
import { type EnginePhase, enginePhase, useEngineStatus } from "../../features/use-engine-status";

export const Route = createFileRoute("/_connected")({
  component: ConnectedLayout,
});

function ConnectedLayout() {
  const { status } = useEngineStatus();
  const phase = enginePhase(status);
  const pageTitle = useMatches().at(-1)?.staticData?.pageTitle ?? "Mission control";

  if (phase !== "up") return <EngineOfflineCard title={pageTitle} phase={phase} />;

  const result = useBoard();
  if (result._tag !== "Success") return <DaemonUnavailable />;

  return <Outlet />;
}

function EngineOfflineCard({ title, phase }: { title: string; phase: Exclude<EnginePhase, "up"> }) {
  return (
    <div className="p-6">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            <EngineOfflineMessage phase={phase} />
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function DaemonUnavailable() {
  const result = useBoard();

  if (result._tag === "Failure") {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTitle>Could not reach the daemon</AlertTitle>
          <AlertDescription>{Cause.pretty(result.cause)}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Connecting to the daemon…</EmptyTitle>
        <EmptyDescription>The view fills in as the event stream self-seeds.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
