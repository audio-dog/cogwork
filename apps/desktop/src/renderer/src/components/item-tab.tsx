import type { PrSummary, ReadModelItem, RunSummary, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { Spinner } from "@cogwork/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { useAtom } from "@effect/atom-react";
import { RiArrowRightLine, RiFileList2Line, RiPulseLine, RiStopCircleLine } from "@remixicon/react";
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { createContext, type ReactNode, use, useState } from "react";
import { cancelRunAtom } from "../daemon/atoms";
import { BoardResult, useBoard } from "../features/activity-session";
import { daemonFailureMessage } from "../features/daemon-failure";
import { boardItem, runForItem, runsForItem } from "../features/feed";
import { relativeTime } from "../features/format";
import {
  attemptTone,
  describeItemState,
  type ItemStateDescriptor,
  previousAttempts,
  resolveSubTab,
  type SubTab,
  type SubTabKey,
  selectedRunForItem,
  subTabs,
} from "../features/item-tab";
import { useRunTranscript } from "../features/run-activity";
import { runStatusLabel } from "../features/run-status";
import { statusLine } from "../features/run-transcript";
import { useNow } from "../features/use-now";
import type { ItemSelection } from "../store/chrome";
import { useRightPanelStore } from "../store/right-panel";
import { PrChecksBadge, PrDivergenceBadge, PrReviewBadge } from "./badges";
import { PullRequest } from "./pull-request";
import { RunTranscript } from "./run-transcript";
import { SurfaceTab } from "./surface-tab";

interface ItemTabState {
  readonly workspace: WorkspaceId;
  readonly item: ReadModelItem;
  readonly run: RunSummary | null;
  readonly attempts: readonly RunSummary[];
  readonly descriptor: ItemStateDescriptor;
  readonly tabs: readonly SubTab[];
  readonly subTab: SubTabKey;
}

interface ItemTabActions {
  readonly setSubTab: (key: SubTabKey) => void;
  readonly cancel: () => void;
}

interface MutationStatus {
  readonly pending: boolean;
  readonly error: string | null;
}

interface ItemTabMeta {
  readonly now: number;
  readonly cancel: MutationStatus;
}

interface ItemTabContextValue {
  readonly state: ItemTabState;
  readonly actions: ItemTabActions;
  readonly meta: ItemTabMeta;
}

const ItemTabContext = createContext<ItemTabContextValue | null>(null);

function useItemTab(): ItemTabContextValue {
  const value = use(ItemTabContext);
  if (!value) throw new Error("Item tab parts must render inside ItemTabProvider");
  return value;
}

const mutationStatus = <A, E>(result: AsyncResult.AsyncResult<A, E>, active = true) => ({
  pending: active && result.waiting,
  error: active && result._tag === "Failure" ? daemonFailureMessage(result.cause) : null,
});

function ItemTabProvider({
  workspace,
  item,
  run,
  attempts,
  initialSubTab,
  children,
}: {
  workspace: WorkspaceId;
  item: ReadModelItem;
  run: RunSummary | null;
  attempts: readonly RunSummary[];
  initialSubTab?: SubTabKey;
  children: ReactNode;
}) {
  const [subTab, setSubTab] = useState<SubTabKey>(
    initialSubTab ?? (run?.status === "running" ? "run" : "main"),
  );
  const [cancelResult, cancelRun] = useAtom(cancelRunAtom);
  const now = useNow();

  const descriptor = describeItemState(run);
  const tabs = subTabs();
  const resolved = resolveSubTab(subTab, tabs);
  const actions: ItemTabActions = {
    setSubTab,
    cancel: () => {
      if (run) cancelRun({ payload: { runId: run.id } });
    },
  };

  const meta: ItemTabMeta = {
    now,
    cancel: mutationStatus(cancelResult),
  };

  return (
    <ItemTabContext
      value={{
        state: {
          workspace,
          item,
          run,
          attempts,
          descriptor,
          tabs,
          subTab: resolved,
        },
        actions,
        meta,
      }}
    >
      {children}
    </ItemTabContext>
  );
}

// --- Sub-tab strip -------------------------------------------------------

function SubTabStrip() {
  const {
    state: { tabs, subTab, descriptor },
    actions: { setSubTab },
  } = useItemTab();
  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-3 py-2">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => setSubTab(tab.key)}
          className={cn(
            "flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium",
            subTab === tab.key
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          {tab.label}
          {tab.key === "run" && descriptor.running && (
            <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
          )}
        </button>
      ))}
    </div>
  );
}

// --- Shared pieces -------------------------------------------------------

function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{children}</h3>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>{title}</SectionLabel>
      {children}
    </section>
  );
}

function StateBadge({ descriptor }: { descriptor: ItemStateDescriptor }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "self-start",
        descriptor.tone === "live" && "border-transparent bg-primary/15 text-primary",
        descriptor.tone === "attention" && "border-transparent bg-warning/15 text-warning",
        descriptor.tone === "ready" && "border-transparent bg-success/15 text-success",
        descriptor.tone === "muted" && "border-transparent bg-muted text-muted-foreground",
      )}
    >
      {descriptor.running && <RiPulseLine data-icon="inline-start" className="animate-pulse" />}
      {descriptor.label}
    </Badge>
  );
}

export function ItemTitle({ title, url }: Pick<ReadModelItem, "title" | "url">) {
  if (!url) return title;
  return (
    <a href={url} rel="noreferrer" target="_blank">
      {title}
    </a>
  );
}

function Header() {
  const {
    state: { workspace, item, descriptor },
  } = useItemTab();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{item.id}</span>
        <span aria-hidden>·</span>
        <span>{workspace}</span>
      </div>
      <h1 className="text-base font-semibold [&>a]:underline-offset-4 [&>a:hover]:underline">
        <ItemTitle title={item.title} url={item.url} />
      </h1>
      <StateBadge descriptor={descriptor} />
    </div>
  );
}

function CancelParkButton() {
  const {
    state: { descriptor },
    actions: { cancel: submitCancel },
    meta: { cancel },
  } = useItemTab();
  if (!descriptor.running) return null;
  return (
    <Button size="sm" variant="outline" disabled={cancel.pending} onClick={submitCancel}>
      {cancel.pending ? <Spinner data-icon="inline-start" /> : <RiStopCircleLine data-icon="inline-start" />}
      Cancel &amp; park
    </Button>
  );
}

function ActionBar() {
  const {
    state: { descriptor },
    meta: { cancel },
  } = useItemTab();
  if (!descriptor.running) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <CancelParkButton />
      </div>
      {cancel.error && <span className="text-xs text-destructive">{cancel.error}</span>}
    </div>
  );
}

function RunningAffordance({ run }: { run: RunSummary }) {
  const {
    actions: { setSubTab },
  } = useItemTab();
  const result = useRunTranscript(run.id);
  const entries = result._tag === "Success" ? result.value.entries : [];
  const line = statusLine(entries, run.status);
  return (
    <button
      type="button"
      onClick={() => setSubTab("run")}
      className="flex w-fit max-w-full cursor-pointer items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-left text-xs hover:bg-primary/10"
    >
      <RiPulseLine className="size-4 shrink-0 animate-pulse text-primary" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-primary">Agent is running.</span>{" "}
        <span className="text-muted-foreground">{line}</span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 font-medium text-primary">
        View live run
        <RiArrowRightLine className="size-3.5" />
      </span>
    </button>
  );
}

function PullRequestSummary({ pr }: { pr: PrSummary }) {
  return (
    <Section title="Pull request">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">PR #{pr.number}</span>
        <PrChecksBadge checks={pr.checks} />
        <PrReviewBadge review={pr.review} />
        <PrDivergenceBadge divergence={pr.baseDivergence} />
      </div>
    </Section>
  );
}

function PreviousAttempts() {
  const {
    state: { attempts },
    meta: { now },
  } = useItemTab();
  if (attempts.length === 0) {
    return (
      <Section title="Previous attempts">
        <p className="text-xs text-muted-foreground italic">No previous attempts.</p>
      </Section>
    );
  }
  return (
    <Section title="Previous attempts">
      <Collapsible>
        <CollapsibleTrigger className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground">
          <RiArrowRightLine className="size-3.5 transition-transform [[data-panel-open]_&]:rotate-90" />
          {attempts.length === 1 ? "1 earlier attempt" : `${attempts.length} earlier attempts`}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-2 flex flex-col gap-2">
            {attempts.map((attempt) => {
              const tone = attemptTone[attempt.status];
              return (
                <li key={attempt.id} className="flex flex-col gap-0.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "font-medium",
                        tone === "succeeded" && "text-success",
                        tone === "failed" && "text-destructive",
                        tone === "abandoned" && "text-muted-foreground",
                      )}
                    >
                      {runStatusLabel[attempt.status]}
                    </span>
                    <span className="text-muted-foreground">{attempt.operation}</span>
                    <span aria-hidden className="text-muted-foreground">
                      ·
                    </span>
                    <span className="text-muted-foreground">
                      {relativeTime(attempt.endedAtMillis ?? attempt.startedAtMillis, now)}
                    </span>
                  </div>
                  <Collapsible>
                    <CollapsibleTrigger className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">
                      Show transcript
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-2 flex h-96 flex-col rounded-md border">
                      <RunTranscript.Provider run={attempt}>
                        <RunTranscript.Conversation />
                      </RunTranscript.Provider>
                    </CollapsibleContent>
                  </Collapsible>
                </li>
              );
            })}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </Section>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-foreground">{value}</span>
    </div>
  );
}

function Metadata({ run }: { run: RunSummary }) {
  const {
    meta: { now },
  } = useItemTab();
  return (
    <Section title="Metadata">
      <div className="flex flex-col gap-1.5">
        <MetaRow label="Branch" value={run.branch ?? "—"} />
        <MetaRow label="Session" value={run.session ?? "—"} />
        <MetaRow label="Harness" value={run.harness} />
        <MetaRow
          label="Tokens"
          value={run.usage?.totalTokens !== undefined ? run.usage.totalTokens.toLocaleString() : "—"}
        />
        <MetaRow label="Started" value={relativeTime(run.startedAtMillis, now)} />
        <MetaRow
          label="Ended"
          value={run.endedAtMillis !== null ? relativeTime(run.endedAtMillis, now) : "—"}
        />
      </div>
    </Section>
  );
}

// --- Sub-tab bodies ------------------------------------------------------

function SubTabBody({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4">{children}</div>
    </ScrollArea>
  );
}

function MainBody() {
  const {
    state: { item, run },
  } = useItemTab();
  return (
    <SubTabBody>
      <Header />
      <ActionBar />
      {run?.status === "running" && <RunningAffordance run={run} />}
      {item.pr && <PullRequestSummary pr={item.pr} />}
      <PreviousAttempts />
      {run && <Metadata run={run} />}
    </SubTabBody>
  );
}

function LiveRunBody() {
  const {
    state: { run },
  } = useItemTab();
  if (!run)
    return (
      <SubTabBody>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No live run</EmptyTitle>
            <EmptyDescription>No run has started for this item.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SubTabBody>
    );
  return (
    <RunTranscript.Provider run={run}>
      <RunTranscript.Now />
      <RunTranscript.Conversation />
    </RunTranscript.Provider>
  );
}

function PullRequestBody({ pr }: { pr: PrSummary }) {
  const {
    state: { item },
    meta: { now },
  } = useItemTab();
  return (
    <SubTabBody>
      <PullRequest pr={pr} now={now} title={item.title} />
    </SubTabBody>
  );
}

function SubTabPanel() {
  const {
    state: { subTab, item },
  } = useItemTab();
  if (subTab === "run") return <LiveRunBody />;
  if (subTab === "pr" && item.pr) return <PullRequestBody pr={item.pr} />;
  return <MainBody />;
}

// --- Shell ---------------------------------------------------------------

function ItemGone() {
  return (
    <div className="flex h-full flex-col p-6">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Item is gone</EmptyTitle>
          <EmptyDescription>This item is no longer on the board.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

export function ItemTab({ selection }: { selection: ItemSelection & { runId?: RunSummary["id"] } }) {
  const result = useBoard();
  if (!BoardResult.$is("Success")(result)) return <ItemGone />;

  const { board } = result;
  const entry = boardItem(board, selection.workspace, selection.workItem);
  if (!entry) return <ItemGone />;

  const selectedRun = selectedRunForItem(
    selection.runId ? board.runs.get(selection.runId) : null,
    selection.workspace,
    selection.workItem,
  );
  const run = selection.runId ? selectedRun : runForItem(board, selection.workspace, selection.workItem);
  const attempts = previousAttempts(
    runsForItem(board, selection.workspace, selection.workItem),
    run?.id ?? null,
  );

  return (
    <ItemTabProvider
      key={`${selection.workspace}:${entry.item.id}`}
      workspace={selection.workspace}
      item={entry.item}
      run={run}
      attempts={attempts}
      initialSubTab={selectedRun ? "run" : undefined}
    >
      <div className="flex h-full min-h-0 flex-col">
        <SubTabStrip />
        <SubTabPanel />
      </div>
    </ItemTabProvider>
  );
}

export function ItemSurfaceTab({
  id,
  workspace,
  workItem,
}: {
  id: `item:${string}:${string}`;
  workspace: WorkspaceId;
  workItem: WorkItemId;
}) {
  const active = useRightPanelStore((state) => state.active === id);
  const setActive = useRightPanelStore((state) => state.setActive);
  const closeSurface = useRightPanelStore((state) => state.closeSurface);
  const Tab = active ? SurfaceTab.Active : SurfaceTab.Inactive;

  return (
    <Tab>
      <Tooltip>
        <TooltipTrigger
          render={
            <SurfaceTab.Button onClick={() => setActive(id)}>
              <RiFileList2Line data-icon="inline-start" />
              <span className="truncate">{workItem}</span>
            </SurfaceTab.Button>
          }
        />
        <TooltipContent side="bottom">{workspace}</TooltipContent>
      </Tooltip>
      <SurfaceTab.Close aria-label={`Close ${workItem}`} onClick={() => closeSurface(id)} />
    </Tab>
  );
}
