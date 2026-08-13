import { Badge } from "@cogwork/ui/components/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { Separator } from "@cogwork/ui/components/separator";
import type { ReactNode } from "react";
import { mergeGate, selfHalts } from "../features/feed";
import { useBoard } from "../features/use-board";
import { useChromeStore } from "../store/chrome";
import { MergeGateCard, SelfHaltCard } from "./attention-items";
import { ItemDetail } from "./item-detail";
import { RailShell } from "./rail-shell";

function RailSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        <Badge variant="outline">{count}</Badge>
      </div>
      {children}
    </section>
  );
}

function RailBody() {
  const result = useBoard();
  const filter = useChromeStore((state) => state.workspaceFilter);

  if (result._tag !== "Success") {
    return <p className="text-xs text-muted-foreground">Waiting for the daemon…</p>;
  }

  const halts = selfHalts(result.board, filter);
  const gate = mergeGate(result.board, filter);

  if (halts.length === 0 && gate.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>All clear</EmptyTitle>
          <EmptyDescription>No self-halts or PRs waiting at the merge gate.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {halts.length > 0 && (
        <RailSection title="Self-halts" count={halts.length}>
          <div className="flex flex-col gap-2">
            {halts.map((entry) => (
              <SelfHaltCard key={`${entry.workspace}:${entry.item.id}`} entry={entry} />
            ))}
          </div>
        </RailSection>
      )}
      {halts.length > 0 && gate.length > 0 && <Separator />}
      {gate.length > 0 && (
        <RailSection title="Merge gate" count={gate.length}>
          <div className="flex flex-col gap-2">
            {gate.map((entry) => (
              <MergeGateCard key={`${entry.workspace}:${entry.item.id}`} entry={entry} />
            ))}
          </div>
        </RailSection>
      )}
    </div>
  );
}

export function AttentionList() {
  return (
    <RailShell header={<h2 className="text-sm font-semibold">Attention</h2>}>
      <RailBody />
    </RailShell>
  );
}

export function AttentionRail() {
  const selection = useChromeStore((state) => state.selection);
  return selection ? <ItemDetail selection={selection} /> : <AttentionList />;
}
