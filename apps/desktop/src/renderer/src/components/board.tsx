import type { ClassifiedItem } from "@clanker-forge/contracts";
import { Badge } from "@clanker-forge/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@clanker-forge/ui/components/card";
import { ScrollArea, ScrollBar } from "@clanker-forge/ui/components/scroll-area";
import type { ReactNode } from "react";
import type { BoardColumn as BoardColumnData } from "../features/board-view";
import { boardColumns } from "../features/board-view";
import type { FeedItem } from "../features/feed";
import { useChromeStore } from "../store/chrome";
import { PrChecksBadge } from "./badges";
import { BoardGate } from "./board-gate";

function itemMeta(item: ClassifiedItem): ReactNode {
  switch (item._tag) {
    case "Eligible":
      return <Badge variant="secondary">{item.stage}</Badge>;
    case "Claimed":
      return <Badge variant="secondary">{item.claim.stage ?? "claimed"}</Badge>;
    case "Blocked":
      return (
        <Badge variant="outline">
          {item.openBlockers} blocker{item.openBlockers === 1 ? "" : "s"}
        </Badge>
      );
    case "NeedsHuman":
      return <Badge variant="outline">{item.reason}</Badge>;
  }
}

function BoardCard({ entry }: { entry: FeedItem }) {
  const { workspace, item } = entry;
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{workspace}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{item.id}</span>
        </div>
        <CardTitle className="mt-1 text-sm">{item.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-1.5">
        {itemMeta(item)}
        {item.pr && <PrChecksBadge checks={item.pr.checks} />}
      </CardContent>
    </Card>
  );
}

function BoardColumn({ column }: { column: BoardColumnData }) {
  return (
    <section className="flex w-72 shrink-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{column.label}</h2>
        <Badge variant="outline">{column.items.length}</Badge>
      </div>
      <div className="flex flex-col gap-2">
        {column.items.map((entry) => (
          <BoardCard key={`${entry.workspace}:${entry.item.id}`} entry={entry} />
        ))}
        {column.items.length === 0 && (
          <p className="rounded-lg px-3 py-6 text-center text-xs text-muted-foreground ring-1 ring-foreground/5">
            Empty
          </p>
        )}
      </div>
    </section>
  );
}

export function Board() {
  const filter = useChromeStore((state) => state.workspaceFilter);
  return (
    <BoardGate>
      {(board) => (
        <ScrollArea className="h-full">
          <div className="flex gap-4 p-6">
            {boardColumns(board, filter).map((column) => (
              <BoardColumn key={column.id} column={column} />
            ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      )}
    </BoardGate>
  );
}
