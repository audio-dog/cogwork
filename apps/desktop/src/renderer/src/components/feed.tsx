import type { WorkspaceId } from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { Skeleton } from "@cogwork/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@cogwork/ui/components/table";
import { RiCheckLine } from "@remixicon/react";
import { type ComponentType, createContext, type ReactNode, use } from "react";
import { BoardResult, useBoard, useOperationName } from "../features/activity-session";
import type { FeedRun, OperationRun } from "../features/feed";
import { recentlyDone, runningRuns } from "../features/feed";
import { elapsed, relativeTime } from "../features/format";
import type { RunActivityPreview } from "../features/run-activity";
import { runStatusLabel } from "../features/run-status";
import { useNow } from "../features/use-now";
import { workspaceLabelById } from "../features/workspace-record";
import type { ItemSelection } from "../store/chrome";
import { useChromeStore } from "../store/chrome";
import { useRightPanelStore } from "../store/right-panel";

interface FeedState {
  running: ReadonlyArray<FeedRun>;
  done: ReadonlyArray<FeedRun>;
  previews: ReadonlyMap<string, RunActivityPreview>;
}

interface FeedActions {
  select: (selection: ItemSelection) => void;
}

interface FeedMeta {
  now: number;
  workspaceName: (workspace: WorkspaceId) => string;
  operationName: (run: OperationRun) => string;
}

interface FeedContextValue {
  state: FeedState;
  actions: FeedActions;
  meta: FeedMeta;
}

const FeedContext = createContext<FeedContextValue | null>(null);

function useFeed(): FeedContextValue {
  const value = use(FeedContext);
  if (!value) throw new Error("Feed parts must render inside Feed.Provider");
  return value;
}

function FeedProvider({
  children,
  state,
  actions,
  meta,
}: {
  children: ReactNode;
  state: FeedState;
  actions: FeedActions;
  meta: FeedMeta;
}) {
  return <FeedContext value={{ state, actions, meta }}>{children}</FeedContext>;
}

function FeedFrame({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 p-6">{children}</div>
    </ScrollArea>
  );
}

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

function TerminalStrip({ entry, preview }: { entry: FeedRun; preview: RunActivityPreview | undefined }) {
  const {
    actions: { select },
    meta: { now, workspaceName, operationName },
  } = useFeed();
  const { run, label, title } = entry;
  return (
    <button
      type="button"
      onClick={() => select({ workspace: run.workspace, workItem: run.workItem })}
      className="flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
    >
      <span className="flex w-full items-center gap-3">
        <TypingDots />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title ?? label}</span>
        <Badge variant="secondary" className="w-20 shrink-0 justify-center">
          {operationName(run)}
        </Badge>
        <span className="w-16 shrink-0 truncate text-end text-xs text-muted-foreground">
          {workspaceName(run.workspace)}
        </span>
        <span className="w-14 shrink-0 truncate text-end font-mono text-xs text-muted-foreground">
          {label}
        </span>
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

function LiveNowSection() {
  const {
    state: { running, previews },
  } = useFeed();
  return (
    <section className="flex flex-col gap-3">
      <SectionHeading title="Live now" count={running.length} live />
      {running.length === 0 ? (
        <EmptyNote>No agents running right now.</EmptyNote>
      ) : (
        <div className="divide-y overflow-hidden rounded-xl border">
          {running.map((entry) => (
            <TerminalStrip key={entry.run.id} entry={entry} preview={previews.get(entry.run.id)} />
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
  declined: { variant: "outline" },
  failed: { variant: "destructive" },
  crashed: { variant: "destructive" },
  interrupted: { variant: "outline" },
  exhausted: { variant: "outline" },
};

function RunStateBadge({ status }: { status: FeedRun["run"]["status"] }) {
  const { variant, icon: Icon } = runStateBadge[status];
  return (
    <Badge variant={variant} className="gap-1 font-normal">
      {Icon && <Icon className="size-3" />}
      {runStatusLabel[status]}
    </Badge>
  );
}

function DoneLedgerRow({ entry }: { entry: FeedRun }) {
  const {
    actions: { select },
    meta: { workspaceName },
  } = useFeed();
  const { run, label, title } = entry;
  return (
    <TableRow
      className="cursor-pointer"
      onClick={() => select({ workspace: run.workspace, workItem: run.workItem })}
    >
      <TableCell>
        <RunStateBadge status={run.status} />
      </TableCell>
      <TableCell className="truncate font-mono text-xs text-muted-foreground">{label}</TableCell>
      <TableCell className="truncate text-foreground">{title ?? label}</TableCell>
      <TableCell>
        <Badge variant="outline">{workspaceName(run.workspace)}</Badge>
      </TableCell>
      <TableCell className="text-end text-xs text-muted-foreground tabular-nums">
        {run.endedAtMillis !== null ? relativeTime(run.endedAtMillis) : "—"}
      </TableCell>
    </TableRow>
  );
}

function LedgerSection() {
  const {
    state: { done },
  } = useFeed();
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Ledger</h2>
        <Badge variant="secondary">{done.length}</Badge>
        <span className="text-xs text-muted-foreground">recently done</span>
      </div>
      {done.length === 0 ? (
        <EmptyNote>Nothing finished yet.</EmptyNote>
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
              {done.map((entry) => (
                <DoneLedgerRow key={`d:${entry.run.id}`} entry={entry} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

const FeedCompound = {
  Provider: FeedProvider,
  Frame: FeedFrame,
  LiveNow: LiveNowSection,
  Ledger: LedgerSection,
};

function FeedContent({
  running,
  done,
  previews,
  workspaceName,
}: FeedState & Pick<FeedMeta, "workspaceName">) {
  const openItem = useRightPanelStore((state) => state.openItem);
  const select = (selection: ItemSelection) => openItem(selection.workspace, selection.workItem);
  const now = useNow();
  const operationName = useOperationName();
  return (
    <FeedCompound.Provider
      state={{ running, done, previews }}
      actions={{ select }}
      meta={{ now, workspaceName, operationName }}
    >
      <FeedCompound.Frame>
        <FeedCompound.LiveNow />
        <FeedCompound.Ledger />
      </FeedCompound.Frame>
    </FeedCompound.Provider>
  );
}

export function FeedSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <section className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24" />
        <div className="flex flex-col gap-2 overflow-hidden rounded-xl border">
          {[0, 1].map((row) => (
            <Skeleton key={row} className="h-14 w-full rounded-none" />
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <Skeleton className="h-4 w-20" />
        <div className="flex flex-col gap-px overflow-hidden rounded-xl border">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-11 w-full rounded-none" />
          ))}
        </div>
      </section>
    </div>
  );
}

export function Feed() {
  const result = useBoard();
  const filter = useChromeStore((state) => state.workspaceFilter);

  if (!BoardResult.$is("Success")(result)) return null;

  const { board, previews } = result;
  const running = runningRuns(board, filter);
  const done = recentlyDone(board, filter);

  if (running.length === 0 && done.length === 0) {
    return (
      <ScrollArea className="h-full">
        <div className="p-6">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Nothing in flight</EmptyTitle>
              <EmptyDescription>
                Running agents and recent results will appear here as the daemon works.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </ScrollArea>
    );
  }

  return (
    <FeedContent
      running={running}
      done={done}
      previews={previews}
      workspaceName={(workspace) => workspaceLabelById(board, workspace)}
    />
  );
}
