import { Badge } from "@clanker-forge/ui/components/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@clanker-forge/ui/components/empty";
import { ScrollArea } from "@clanker-forge/ui/components/scroll-area";
import type { ReactNode } from "react";
import { mergeGate, selfHalts } from "../features/feed";
import { useChromeStore } from "../store/chrome";
import { MergeGateCard, SelfHaltCard } from "./attention-items";
import { BoardGate } from "./board-gate";

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
        <Badge variant="outline">{count}</Badge>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
    </section>
  );
}

export function Inbox() {
  const filter = useChromeStore((state) => state.workspaceFilter);
  return (
    <BoardGate>
      {(board) => {
        const halts = selfHalts(board, filter);
        const gate = mergeGate(board, filter);

        if (halts.length === 0 && gate.length === 0) {
          return (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Inbox zero</EmptyTitle>
                <EmptyDescription>
                  Nothing is waiting on you — no self-halts and no PRs at the merge gate.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          );
        }

        return (
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-8 p-6">
              <h1 className="text-lg font-semibold">Inbox</h1>
              {halts.length > 0 && (
                <Section title="Self-halts" count={halts.length}>
                  {halts.map((entry) => (
                    <SelfHaltCard key={`${entry.workspace}:${entry.item.id}`} entry={entry} />
                  ))}
                </Section>
              )}
              {gate.length > 0 && (
                <Section title="Merge gate" count={gate.length}>
                  {gate.map((entry) => (
                    <MergeGateCard key={`${entry.workspace}:${entry.item.id}`} entry={entry} />
                  ))}
                </Section>
              )}
            </div>
          </ScrollArea>
        );
      }}
    </BoardGate>
  );
}
