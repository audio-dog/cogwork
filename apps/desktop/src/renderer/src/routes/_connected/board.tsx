import { ScrollArea, ScrollBar } from "@clanker-forge/ui/components/scroll-area";
import { createFileRoute } from "@tanstack/react-router";
import { ColumnHead, KanbanCard } from "../../components/mission-control-ui";
import { boardColumns } from "../../features/board-view";
import { useBoard } from "../../features/use-board";
import { useChromeStore } from "../../store/chrome";

function BoardPage() {
  const result = useBoard();
  const filter = useChromeStore((state) => state.workspaceFilter);
  if (result._tag !== "Success") return null;

  return (
    <ScrollArea className="h-full">
      <div className="flex items-start gap-3.5 p-[18px]">
        {boardColumns(result.board, filter).map((column) => (
          <section key={column.id} className="flex w-[244px] shrink-0 flex-col">
            <ColumnHead label={column.label} count={column.items.length} />
            <div className="flex flex-col gap-2.5">
              {column.items.length === 0 ? (
                <p className="rounded-[10px] border border-dashed px-1 py-2.5 text-center text-xs text-muted-foreground">
                  empty
                </p>
              ) : (
                column.items.map((entry) => (
                  <KanbanCard key={`${entry.workspace}:${entry.item.id}`} entry={entry} />
                ))
              )}
            </div>
          </section>
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
}

export const Route = createFileRoute("/_connected/board")({
  staticData: { pageTitle: "Board" },
  component: BoardPage,
});
