import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { Badge } from "@cogwork/ui/components/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@cogwork/ui/components/table";
import { RiCheckLine, RiTimeLine } from "@remixicon/react";
import type { ComponentType, ReactNode } from "react";
import { daemonErrorMessage } from "../features/daemon-error";
import type { FeedRun, QueuedItem } from "../features/feed";
import { queuedItems, recentlyDone, runningRuns } from "../features/feed";
import { elapsed, relativeTime } from "../features/format";
import type { RunActivityPreview } from "../features/run-activity";
import { useBoard } from "../features/use-board";
import { useNow } from "../features/use-now";
import { useChromeStore } from "../store/chrome";

// Three small staggered-fade dots: the "live" indicator on a running strip. A
// spinning loader reads as too busy stacked across many strips, so we keep it
// calm (decision on #15).
function TypingDots() {
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center gap-0.5" aria-hidden>
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="size-1 animate-pulse rounded-full bg-primary"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

function SectionHeading({ title, count, live }: { title: string; count: number; live?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {live && <TypingDots />}
      <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{title}</h2>
      <Badge variant="secondary">{count}</Badge>
    </div>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

// The live console line: `label ▸ preview` in monospace with a blinking caret,
// so a strip reads like a terminal tailing the run.
function ConsoleLine({ preview }: { preview: RunActivityPreview | undefined }) {
  return (
    <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
      <span className="text-primary">{preview?.label ?? "working"}</span>
      <span className="text-muted-foreground/60"> ▸ </span>
      {preview?.text || ""}
      <span className="ms-0.5 inline-block animate-pulse text-primary">▋</span>
    </span>
  );
}

// One terminal strip: a right meta-rail (stage / workspace / id / elapsed) in
// fixed-width columns so they line up across rows, with the console line below.
function TerminalStrip({
  entry,
  preview,
  now,
}: {
  entry: FeedRun;
  preview: RunActivityPreview | undefined;
  now: number;
}) {
  const select = useChromeStore((state) => state.select);
  const { run, title } = entry;
  return (
    <button
      type="button"
      onClick={() => select({ workspace: run.workspace, workItem: run.workItem })}
      className="flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
    >
      <span className="flex w-full items-center gap-3">
        <TypingDots />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title ?? run.workItem}</span>
        <Badge variant="secondary" className="w-20 shrink-0 justify-center">
          {run.stage}
        </Badge>
        <span className="w-16 shrink-0 truncate text-end text-xs text-muted-foreground">{run.workspace}</span>
        <span className="w-14 shrink-0 text-end font-mono text-xs text-muted-foreground">{run.workItem}</span>
        <span className="w-12 shrink-0 text-end font-mono text-xs text-muted-foreground tabular-nums">
          {elapsed(run.startedAtMillis, now)}
        </span>
      </span>
      <span className="flex ps-[1.375rem]">
        <ConsoleLine preview={preview} />
      </span>
    </button>
  );
}

function LiveNow({
  running,
  previews,
}: {
  running: ReadonlyArray<FeedRun>;
  previews: ReadonlyMap<string, RunActivityPreview>;
}) {
  const now = useNow();
  return (
    <section className="flex flex-col gap-3">
      <SectionHeading title="Live now" count={running.length} live />
      {running.length === 0 ? (
        <EmptyNote>No agents running right now.</EmptyNote>
      ) : (
        <div className="divide-y overflow-hidden rounded-xl border">
          {running.map((entry) => (
            <TerminalStrip key={entry.run.id} entry={entry} preview={previews.get(entry.run.id)} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}

const runStateBadge: Record<
  FeedRun["run"]["status"],
  { variant: "secondary" | "destructive" | "outline"; icon?: ComponentType<{ className?: string }> }
> = {
  running: { variant: "secondary" },
  succeeded: { variant: "secondary", icon: RiCheckLine },
  failed: { variant: "destructive" },
  crashed: { variant: "destructive" },
  interrupted: { variant: "outline" },
  exhausted: { variant: "outline" },
};

function RunStateBadge({ status }: { status: FeedRun["run"]["status"] }) {
  const { variant, icon: Icon } = runStateBadge[status];
  return (
    <Badge variant={variant} className="gap-1 font-normal capitalize">
      {Icon && <Icon className="size-3" />}
      {status}
    </Badge>
  );
}

function QueuedBadge() {
  return (
    <Badge variant="outline" className="gap-1 font-normal">
      <RiTimeLine className="size-3" />
      Queued
    </Badge>
  );
}

function LedgerRow({
  state,
  id,
  title,
  workspace,
  when,
  onClick,
}: {
  state: ReactNode;
  id: string;
  title: string;
  workspace: string;
  when: string;
  onClick: () => void;
}) {
  return (
    <TableRow className="cursor-pointer" onClick={onClick}>
      <TableCell>{state}</TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{id}</TableCell>
      <TableCell className="truncate text-foreground">{title}</TableCell>
      <TableCell>
        <Badge variant="outline">{workspace}</Badge>
      </TableCell>
      <TableCell className="text-end text-xs text-muted-foreground tabular-nums">{when}</TableCell>
    </TableRow>
  );
}

// The ledger folds queued and recently-done into one reference table, splitting
// "watch" (the live strips above) from "look it up".
function Ledger({ queued, done }: { queued: ReadonlyArray<QueuedItem>; done: ReadonlyArray<FeedRun> }) {
  const select = useChromeStore((state) => state.select);
  const total = queued.length + done.length;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Ledger</h2>
        <Badge variant="secondary">{total}</Badge>
        <span className="text-xs text-muted-foreground">queued &amp; recently done</span>
      </div>
      {total === 0 ? (
        <EmptyNote>Nothing queued or finished yet.</EmptyNote>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-32 text-[10px] tracking-wider uppercase">State</TableHead>
                <TableHead className="w-20 text-[10px] tracking-wider uppercase">Item</TableHead>
                <TableHead className="text-[10px] tracking-wider uppercase">Title</TableHead>
                <TableHead className="w-36 text-[10px] tracking-wider uppercase">Workspace</TableHead>
                <TableHead className="w-24 text-end text-[10px] tracking-wider uppercase">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queued.map((entry) => (
                <LedgerRow
                  key={`q:${entry.workspace}:${entry.item.id}`}
                  state={<QueuedBadge />}
                  id={entry.item.id}
                  title={entry.item.title}
                  workspace={entry.workspace}
                  when={entry.item.stage}
                  onClick={() => select({ workspace: entry.workspace, workItem: entry.item.id })}
                />
              ))}
              {done.map((entry) => (
                <LedgerRow
                  key={`d:${entry.run.id}`}
                  state={<RunStateBadge status={entry.run.status} />}
                  id={entry.run.workItem}
                  title={entry.title ?? entry.run.workItem}
                  workspace={entry.run.workspace}
                  when={entry.run.endedAtMillis !== null ? relativeTime(entry.run.endedAtMillis) : "—"}
                  onClick={() => select({ workspace: entry.run.workspace, workItem: entry.run.workItem })}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
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

  if (running.length === 0 && queued.length === 0 && done.length === 0) {
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
      <div className="flex flex-col gap-6 p-6">
        <LiveNow running={running} previews={previews} />
        <Ledger queued={queued} done={done} />
      </div>
    </ScrollArea>
  );
}
