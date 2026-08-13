import { Badge } from "@cogwork/ui/components/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { ScrollArea, ScrollBar } from "@cogwork/ui/components/scroll-area";
import { createFileRoute } from "@tanstack/react-router";
import { LaneMiniCard } from "../../components/mission-control-ui";
import type { Lane } from "../../features/board-view";
import { lanes } from "../../features/board-view";
import { useBoard } from "../../features/use-board";

export const Route = createFileRoute("/_connected/lanes")({
  staticData: { pageTitle: "Lanes" },
  component: LanesPage,
});

function LanesPage() {
  const result = useBoard();
  if (result._tag !== "Success") return null;

  const rows = lanes(result.board);
  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No workspaces</EmptyTitle>
          <EmptyDescription>Register a workspace to see it appear as a lane here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3.5 px-5 py-[18px] pb-10">
        {rows.map((lane) => (
          <LaneRow key={lane.key} lane={lane} />
        ))}
      </div>
    </ScrollArea>
  );
}

function LaneRow({ lane }: { lane: Lane }) {
  return (
    <article className="overflow-hidden rounded-[13px] border bg-card">
      <LaneHead lane={lane} />
      <LaneBody lane={lane} />
    </article>
  );
}

function LaneHead({ lane }: { lane: Lane }) {
  return (
    <div className="flex items-center gap-2.5 border-b bg-muted/30 px-3.5 py-2.5">
      <span className="font-semibold">{lane.key}</span>
      <span className="text-xs text-muted-foreground">
        {lane.total} items · {lane.running} running
      </span>
      {lane.needsYou > 0 && (
        <Badge variant="outline" className="ms-auto">
          {lane.needsYou} need you
        </Badge>
      )}
      {lane.state._tag === "Failed" && (
        <Badge variant="destructive" className="ms-auto">
          Failed to load
        </Badge>
      )}
      {lane.state._tag === "Registered" && lane.state.poll.status === "paused" && (
        <Badge variant="outline" className="ms-auto">
          Polling paused
        </Badge>
      )}
    </div>
  );
}

function LaneBody({ lane }: { lane: Lane }) {
  if (lane.state._tag === "Failed") {
    return <p className="px-3.5 py-3 text-sm text-destructive">{lane.state.message}</p>;
  }

  return (
    <ScrollArea className="w-full">
      <div className="flex gap-3 px-3.5 py-3">
        {lane.columns.map((column) => (
          <section key={column.id} className="min-w-[150px] shrink-0">
            <h3 className="mb-1.5 text-[10.5px] tracking-wider text-muted-foreground uppercase">
              {column.label} · {column.count}
            </h3>
            {column.items.length === 0 ? (
              <p className="text-xs text-muted-foreground">—</p>
            ) : (
              column.items.map((entry) => (
                <LaneMiniCard
                  key={`${entry.workspace}:${entry.item.id}`}
                  entry={entry}
                  running={entry.item._tag === "Claimed"}
                />
              ))
            )}
          </section>
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
}
