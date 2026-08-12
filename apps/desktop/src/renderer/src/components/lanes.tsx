import type { WorkspaceState } from "@clanker-forge/contracts";
import { Badge } from "@clanker-forge/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@clanker-forge/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@clanker-forge/ui/components/empty";
import { ScrollArea } from "@clanker-forge/ui/components/scroll-area";
import type { Lane, LaneColumn } from "../features/board-view";
import { lanes } from "../features/board-view";
import { BoardGate } from "./board-gate";

function StateBadges({ state }: { state: WorkspaceState }) {
  if (state._tag === "Failed") return <Badge variant="destructive">Failed to load</Badge>;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {state.issueTracker} · {state.harness}
      </span>
      {state.poll.status === "paused" && (
        <Badge variant="outline">Polling paused · {state.poll.reason}</Badge>
      )}
    </div>
  );
}

function ColumnCount({ column }: { column: LaneColumn }) {
  return (
    <div className="flex min-w-20 flex-col items-center gap-1 rounded-lg px-3 py-2 ring-1 ring-foreground/5">
      <span className="text-lg font-semibold tabular-nums">{column.count}</span>
      <span className="text-center text-[11px] text-muted-foreground">{column.label}</span>
    </div>
  );
}

function LaneRow({ lane }: { lane: Lane }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">{lane.key}</CardTitle>
          <div className="flex items-center gap-2">
            {lane.running > 0 && <Badge>{lane.running} running</Badge>}
            <StateBadges state={lane.state} />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {lane.state._tag === "Failed" ? (
          <p className="text-sm text-destructive">{lane.state.message}</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {lane.columns.map((column) => (
              <ColumnCount key={column.id} column={column} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Lanes() {
  return (
    <BoardGate>
      {(board) => {
        const rows = lanes(board);
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
            <div className="flex flex-col gap-4 p-6">
              <h1 className="text-lg font-semibold">Lanes</h1>
              {rows.map((lane) => (
                <LaneRow key={lane.key} lane={lane} />
              ))}
            </div>
          </ScrollArea>
        );
      }}
    </BoardGate>
  );
}
