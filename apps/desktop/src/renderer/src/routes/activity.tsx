import type { DaemonEvent } from "@clanker-forge/contracts";
import { Alert, AlertDescription, AlertTitle } from "@clanker-forge/ui/components/alert";
import { Badge } from "@clanker-forge/ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@clanker-forge/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@clanker-forge/ui/components/empty";
import { createFileRoute } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
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

function ActivityBody() {
  const result = useLiveEvents();

  if (result._tag === "Failure") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Event stream disconnected</AlertTitle>
        <AlertDescription>{Cause.pretty(result.cause)}</AlertDescription>
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
  return (
    <div className="p-6">
      <ActivityBody />
    </div>
  );
}

export const Route = createFileRoute("/activity")({
  component: ActivityPage,
});
