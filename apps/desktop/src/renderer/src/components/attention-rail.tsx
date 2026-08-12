import { Badge } from "@clanker-forge/ui/components/badge";
import { Button } from "@clanker-forge/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@clanker-forge/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@clanker-forge/ui/components/empty";
import { Separator } from "@clanker-forge/ui/components/separator";
import { RiExternalLinkLine, RiGitPullRequestLine, RiQuestionAnswerLine } from "@remixicon/react";
import type { ReactNode } from "react";
import type { FeedItem, MergeGateItem } from "../features/feed";
import { mergeGate, needsHumanReasonLabel, selfHalts } from "../features/feed";
import { relativeTime } from "../features/format";
import { useBoard } from "../features/use-board";
import { useChromeStore } from "../store/chrome";
import { PrChecksBadge } from "./badges";
import { ItemDetail } from "./item-detail";
import { RailShell } from "./rail-shell";

function SelfHaltCard({ entry }: { entry: FeedItem }) {
  const { item } = entry;
  const select = useChromeStore((state) => state.select);
  if (item._tag !== "NeedsHuman") return null;
  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-muted/50"
      size="sm"
      onClick={() => select({ workspace: entry.workspace, workItem: item.id })}
    >
      <CardHeader>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RiQuestionAnswerLine className="size-3.5" />
          <span>{entry.workspace}</span>
          <span aria-hidden>·</span>
          <span>{item.id}</span>
        </div>
        <CardTitle className="mt-1 text-sm">{item.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Badge variant="outline">{needsHumanReasonLabel[item.reason]}</Badge>
        {item.proposal ? (
          <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground whitespace-pre-wrap">
            {item.proposal}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground italic">No proposal recorded.</p>
        )}
      </CardContent>
    </Card>
  );
}

function MergeGateCard({ entry }: { entry: MergeGateItem }) {
  const { item, pr } = entry;
  const select = useChromeStore((state) => state.select);
  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-muted/50"
      size="sm"
      onClick={() => select({ workspace: entry.workspace, workItem: item.id })}
    >
      <CardHeader>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RiGitPullRequestLine className="size-3.5" />
          <span>{entry.workspace}</span>
          <span aria-hidden>·</span>
          <span>#{pr.number}</span>
        </div>
        <CardTitle className="mt-1 text-sm">{item.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <PrChecksBadge checks={pr.checks} />
          {pr.baseDivergence === "conflict" && <Badge variant="destructive">Conflicts</Badge>}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">waiting {relativeTime(pr.waitingSinceMillis)}</span>
          <Button
            size="xs"
            variant="ghost"
            render={<a href={pr.url} rel="noreferrer" target="_blank" />}
            onClick={(event) => event.stopPropagation()}
          >
            Open PR
            <RiExternalLinkLine data-icon="inline-end" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

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

function AttentionList() {
  const result = useBoard();
  const filter = useChromeStore((state) => state.workspaceFilter);

  const body = () => {
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
  };

  return <RailShell header={<h2 className="text-sm font-semibold">Attention</h2>}>{body()}</RailShell>;
}

export function AttentionRail() {
  const selection = useChromeStore((state) => state.selection);
  return selection ? <ItemDetail selection={selection} /> : <AttentionList />;
}
