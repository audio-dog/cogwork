import { Alert, AlertDescription, AlertTitle } from "@clanker-forge/ui/components/alert";
import { Badge } from "@clanker-forge/ui/components/badge";
import { Button } from "@clanker-forge/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@clanker-forge/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@clanker-forge/ui/components/empty";
import { ScrollArea } from "@clanker-forge/ui/components/scroll-area";
import { Separator } from "@clanker-forge/ui/components/separator";
import { RiEyeLine, RiGitBranchLine } from "@remixicon/react";
import * as Cause from "effect/Cause";
import type { ReactNode } from "react";
import type { FeedRun, QueuedItem } from "../features/feed";
import { blockedCount, queuedItems, recentlyDone, runningRuns } from "../features/feed";
import { elapsed, relativeTime } from "../features/format";
import { useBoard } from "../features/use-board";
import { useChromeStore } from "../store/chrome";
import { RunStatusBadge } from "./badges";

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
        {count !== undefined && <Badge variant="outline">{count}</Badge>}
      </div>
      {children}
    </section>
  );
}

function RunningCard({ entry }: { entry: FeedRun }) {
  const { run, title } = entry;
  const select = useChromeStore((state) => state.select);
  const watch = () => select({ workspace: run.workspace, workItem: run.workItem });
  return (
    <Card className="cursor-pointer transition-colors hover:bg-muted/50" onClick={watch}>
      <CardHeader>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RunStatusBadge status={run.status} />
          <span>{run.workspace}</span>
          <span aria-hidden>·</span>
          <Badge variant="secondary">{run.stage}</Badge>
        </div>
        <CardTitle className="mt-1">{title ?? run.workItem}</CardTitle>
        <CardAction>
          <Button size="sm" variant="outline" onClick={watch}>
            <RiEyeLine data-icon="inline-start" />
            Watch
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{run.harness}</span>
        {run.branch && (
          <span className="flex items-center gap-1">
            <RiGitBranchLine className="size-3.5" />
            <span className="truncate">{run.branch}</span>
          </span>
        )}
        <span>running {elapsed(run.startedAtMillis)}</span>
        <span>
          {run.eventCount} event{run.eventCount === 1 ? "" : "s"}
        </span>
      </CardContent>
    </Card>
  );
}

function SelectableRow({ onSelect, children }: { onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm ring-1 ring-foreground/10 transition-colors hover:bg-muted/50"
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

function QueuedRow({ entry }: { entry: QueuedItem }) {
  const select = useChromeStore((state) => state.select);
  return (
    <SelectableRow onSelect={() => select({ workspace: entry.workspace, workItem: entry.item.id })}>
      <Badge variant="secondary">{entry.item.stage}</Badge>
      <span className="truncate">{entry.item.title}</span>
      <span className="ms-auto shrink-0 text-xs text-muted-foreground">
        {entry.workspace} · {entry.item.id}
      </span>
    </SelectableRow>
  );
}

function DoneRow({ entry }: { entry: FeedRun }) {
  const { run, title } = entry;
  const select = useChromeStore((state) => state.select);
  return (
    <SelectableRow onSelect={() => select({ workspace: run.workspace, workItem: run.workItem })}>
      <RunStatusBadge status={run.status} />
      <span className="truncate">{title ?? run.workItem}</span>
      <span className="ms-auto shrink-0 text-xs text-muted-foreground">
        {run.workspace}
        {run.endedAtMillis !== null && ` · ${relativeTime(run.endedAtMillis)}`}
      </span>
    </SelectableRow>
  );
}

export function Feed() {
  const result = useBoard();
  const filter = useChromeStore((state) => state.workspaceFilter);

  if (result._tag === "Failure") {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTitle>Could not reach the daemon</AlertTitle>
          <AlertDescription>{Cause.pretty(result.cause)}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (result._tag === "Initial") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Connecting to the daemon…</EmptyTitle>
          <EmptyDescription>The feed fills in as the event stream self-seeds.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const { board } = result;
  const running = runningRuns(board, filter);
  const queued = queuedItems(board, filter);
  const done = recentlyDone(board, filter);
  const blocked = blockedCount(board, filter);

  const isEmpty = running.length === 0 && queued.length === 0 && done.length === 0;

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-8 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Feed</h1>
          {blocked > 0 && <Badge variant="outline">{blocked} blocked</Badge>}
        </div>

        {isEmpty && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Nothing in flight</EmptyTitle>
              <EmptyDescription>
                Running agents, queued work, and recent results will appear here as the daemon works.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {running.length > 0 && (
          <Section title="Running" count={running.length}>
            <div className="flex flex-col gap-4">
              {running.map((entry) => (
                <RunningCard key={entry.run.id} entry={entry} />
              ))}
            </div>
          </Section>
        )}

        {queued.length > 0 && (
          <Section title="Queued" count={queued.length}>
            <div className="flex flex-col gap-2">
              {queued.map((entry) => (
                <QueuedRow key={`${entry.workspace}:${entry.item.id}`} entry={entry} />
              ))}
            </div>
          </Section>
        )}

        {done.length > 0 && (
          <Section title="Recently done">
            <div className="flex flex-col gap-2">
              {done.map((entry) => (
                <DoneRow key={entry.run.id} entry={entry} />
              ))}
            </div>
            <Separator />
          </Section>
        )}
      </div>
    </ScrollArea>
  );
}
