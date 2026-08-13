import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { Item, ItemActions, ItemContent, ItemGroup } from "@cogwork/ui/components/item";
import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { RiArrowRightSLine } from "@remixicon/react";
import type { ReactNode } from "react";
import { daemonErrorMessage } from "../features/daemon-error";
import type { FeedRun, QueuedItem } from "../features/feed";
import { queuedItems, recentlyDone, runningRuns } from "../features/feed";
import { relativeTime } from "../features/format";
import type { RunActivityPreview } from "../features/run-activity";
import { useBoard } from "../features/use-board";
import { useChromeStore } from "../store/chrome";

function LiveDot() {
  return <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />;
}

function WorkspaceChip({ workspace }: { workspace: string }) {
  return <Badge variant="outline">{workspace}</Badge>;
}

function Section({
  title,
  count,
  live,
  children,
}: {
  title: string;
  count: number;
  live?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {live && <LiveDot />}
        <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{title}</h2>
        <Badge variant="secondary">{count}</Badge>
      </div>
      {children}
    </section>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function LivePreview({ preview }: { preview: RunActivityPreview | undefined }) {
  if (!preview) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/40 p-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-primary uppercase">
        <LiveDot />
        {preview.label}
      </div>
      <p className="truncate font-mono text-xs text-muted-foreground">{preview.text || "…"}</p>
    </div>
  );
}

function LiveCard({ entry, preview }: { entry: FeedRun; preview: RunActivityPreview | undefined }) {
  const { run, title } = entry;
  const select = useChromeStore((state) => state.select);
  const watch = () => select({ workspace: run.workspace, workItem: run.workItem });
  return (
    <Card className="cursor-pointer transition-colors hover:bg-muted/50" onClick={watch}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{run.workItem}</span>
          <WorkspaceChip workspace={run.workspace} />
          <Badge variant="secondary">{run.stage}</Badge>
        </div>
        <CardTitle className="mt-1">{title ?? run.workItem}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <LivePreview preview={preview} />
        <Button variant="link" size="sm" className="justify-start px-0" onClick={watch}>
          <RiArrowRightSLine data-icon="inline-start" />
          Watch this agent
        </Button>
      </CardContent>
    </Card>
  );
}

function QueuedRow({ entry }: { entry: QueuedItem }) {
  const { item, workspace } = entry;
  const select = useChromeStore((state) => state.select);
  return (
    <Item
      render={<li />}
      variant="outline"
      size="sm"
      className="cursor-pointer"
      onClick={() => select({ workspace, workItem: item.id })}
    >
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{item.id}</span>
      <Badge variant="secondary">{item.stage}</Badge>
      <ItemContent className="min-w-0 flex-1">
        <span className="truncate text-sm">{item.title}</span>
      </ItemContent>
      <ItemActions>
        {item.pr && <Badge variant="outline">PR #{item.pr.number}</Badge>}
        <WorkspaceChip workspace={workspace} />
      </ItemActions>
    </Item>
  );
}

function DoneRow({ entry }: { entry: FeedRun }) {
  const { run, title } = entry;
  const select = useChromeStore((state) => state.select);
  return (
    <Item
      render={<li />}
      variant="outline"
      size="sm"
      className="cursor-pointer"
      onClick={() => select({ workspace: run.workspace, workItem: run.workItem })}
    >
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{run.workItem}</span>
      <ItemContent className="min-w-0 flex-1">
        <span className="truncate text-sm">{title ?? run.workItem}</span>
      </ItemContent>
      <ItemActions>
        {run.endedAtMillis !== null && (
          <span className="text-xs text-muted-foreground">{relativeTime(run.endedAtMillis)}</span>
        )}
        <WorkspaceChip workspace={run.workspace} />
      </ItemActions>
    </Item>
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
          <AlertDescription>{daemonErrorMessage(result.cause)}</AlertDescription>
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

  const { board, previews } = result;
  const running = runningRuns(board, filter);
  const queued = queuedItems(board, filter);
  const done = recentlyDone(board, filter);

  const isEmpty = running.length === 0 && queued.length === 0 && done.length === 0;

  if (isEmpty) {
    return (
      <ScrollArea className="h-full">
        <div className="p-6">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Nothing in flight</EmptyTitle>
              <EmptyDescription>
                Running agents, queued work, and recent results will appear here as the daemon works.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-8 p-6">
        <Section title="Live now" count={running.length} live>
          {running.length === 0 ? (
            <EmptyNote>No agents running.</EmptyNote>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-4">
              {running.map((entry) => (
                <LiveCard key={entry.run.id} entry={entry} preview={previews.get(entry.run.id)} />
              ))}
            </div>
          )}
        </Section>

        <Section title="Queued" count={queued.length}>
          {queued.length === 0 ? (
            <EmptyNote>Nothing queued.</EmptyNote>
          ) : (
            <ItemGroup>
              {queued.map((entry) => (
                <QueuedRow key={`${entry.workspace}:${entry.item.id}`} entry={entry} />
              ))}
            </ItemGroup>
          )}
        </Section>

        <Section title="Recently done" count={done.length}>
          {done.length === 0 ? (
            <EmptyNote>Nothing done yet.</EmptyNote>
          ) : (
            <ItemGroup>
              {done.map((entry) => (
                <DoneRow key={entry.run.id} entry={entry} />
              ))}
            </ItemGroup>
          )}
        </Section>
      </div>
    </ScrollArea>
  );
}
