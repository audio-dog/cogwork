import type { DaemonEvent } from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import { Skeleton } from "@cogwork/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { EngineGate } from "../../components/engine-gate";
import { useLiveEvents } from "../../features/use-live-events";

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

function ActivitySkeleton() {
  return (
    <div className="p-6">
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-28" />
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((row) => (
              <Skeleton key={row} className="h-5 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function LiveActivity() {
  const result = useLiveEvents();

  if (result._tag !== "Success") return null;

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
    <EngineGate.Provider>
      <EngineGate.Live>
        <div className="p-6">
          <LiveActivity />
        </div>
      </EngineGate.Live>
      <EngineGate.Connecting>
        <ActivitySkeleton />
      </EngineGate.Connecting>
      <EngineGate.Off />
      <EngineGate.Broken />
    </EngineGate.Provider>
  );
}

export const Route = createFileRoute("/_app/activity")({
  component: ActivityPage,
});
