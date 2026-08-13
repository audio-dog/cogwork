import type { DaemonEvent } from "@cogwork/contracts";
import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { Badge } from "@cogwork/ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { createFileRoute } from "@tanstack/react-router";
import { daemonErrorMessage } from "../features/daemon-error";
import { EngineOfflineMessage } from "../features/engine-offline";
import { type EnginePhase, enginePhase, useEngineStatus } from "../features/use-engine-status";
import { useLiveEvents } from "../features/use-live-events";

const describeEvent = (event: DaemonEvent) => {
  switch (event._tag) {
    case "RunActivity":
      return `run ${event.activity.runId} · #${event.activity.seq}`;
    case "ItemChanged":
      return `${event.workspace} · ${event.item.id}`;
    case "RunChanged":
      return `run ${event.run.id} → ${event.run.status}`;
    case "SchedulerChanged":
      return `${event.scheduler.globalInFlight} / ${event.scheduler.globalLimit} in flight`;
  }
};

function EventRow({ event }: { event: DaemonEvent }) {
  return (
    <li className="flex items-center gap-3 text-sm">
      <Badge variant="secondary">{event._tag}</Badge>
      <span className="text-muted-foreground">{describeEvent(event)}</span>
    </li>
  );
}

function EngineOfflineEmpty({ phase }: { phase: Exclude<EnginePhase, "up"> }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Engine is off</EmptyTitle>
        <EmptyDescription>
          <EngineOfflineMessage phase={phase} />
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function LiveActivity() {
  const result = useLiveEvents();

  if (result._tag === "Failure") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Event stream disconnected</AlertTitle>
        <AlertDescription>{daemonErrorMessage(result.cause)}</AlertDescription>
      </Alert>
    );
  }

  if (result._tag === "Initial") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Waiting for daemon events</EmptyTitle>
          <EmptyDescription>
            The stream is live over an AtomRpc pull atom; events appear here as they arrive.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const { items } = result.value;
  const start = Math.max(0, items.length - 8);
  const recent = items.slice(start);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Live activity</CardTitle>
        <CardDescription>{items.length} events received this session</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {recent.map((event, offset) => <EventRow key={start + offset} event={event} />).reverse()}
        </ul>
      </CardContent>
    </Card>
  );
}

function ActivityPage() {
  const { status } = useEngineStatus();
  const phase = enginePhase(status);

  return (
    <div className="p-6">{phase === "up" ? <LiveActivity /> : <EngineOfflineEmpty phase={phase} />}</div>
  );
}

export const Route = createFileRoute("/activity")({
  component: ActivityPage,
});
