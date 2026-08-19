import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { Separator } from "@cogwork/ui/components/separator";
import type { ReactNode } from "react";
import { boardItem, runForItem } from "../features/feed";
import { useBoard } from "../features/use-board";
import type { ItemSelection } from "../store/chrome";
import { PrGate } from "./pr-gate";
import { RailShell } from "./rail-shell";
import { RunDrillIn } from "./run-drill-in";
import { TriageApproval } from "./triage-approval";

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function DetailHeader({ title }: { title: string }) {
  return <h2 className="truncate text-sm font-semibold">{title}</h2>;
}

export function ItemDetail({ selection }: { selection: ItemSelection }) {
  const result = useBoard();
  const entry =
    result._tag === "Success" ? boardItem(result.board, selection.workspace, selection.workItem) : null;

  if (!entry) {
    return (
      <RailShell header={<DetailHeader title="Item detail" />}>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Item is gone</EmptyTitle>
            <EmptyDescription>This item is no longer on the board.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </RailShell>
    );
  }

  const { item } = entry;
  const run =
    result._tag === "Success" ? runForItem(result.board, selection.workspace, selection.workItem) : null;

  interface Section {
    readonly key: string;
    readonly node: ReactNode;
  }

  const candidates: ReadonlyArray<Section | null> = [
    item._tag === "NeedsHuman"
      ? {
          key: "triage",
          node: (
            <DetailSection title="Triage">
              <TriageApproval workspace={selection.workspace} item={item} />
            </DetailSection>
          ),
        }
      : null,
    run
      ? {
          key: "run",
          node: (
            <DetailSection title="Run">
              <RunDrillIn run={run} />
            </DetailSection>
          ),
        }
      : null,
    item.pr
      ? {
          key: "pr",
          node: (
            <DetailSection title="Pull request">
              <PrGate pr={item.pr} />
            </DetailSection>
          ),
        }
      : null,
  ];
  const sections = candidates.filter((section): section is Section => section !== null);

  return (
    <RailShell header={<DetailHeader title={item.title} />}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{selection.workspace}</span>
          <span aria-hidden>·</span>
          <span>{item.id}</span>
        </div>
        <h1 className="text-sm font-semibold">{item.title}</h1>
      </div>

      {sections.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing to act on</EmptyTitle>
            <EmptyDescription>
              This item has no live run, self-halt, or pull request right now.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="mt-4 flex flex-col gap-5">
          {sections.map((section, index) => (
            <div key={section.key} className="flex flex-col gap-5">
              {index > 0 && <Separator />}
              {section.node}
            </div>
          ))}
        </div>
      )}
    </RailShell>
  );
}
