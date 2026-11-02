import {
  ClassifiedItem,
  type NeedsHumanItem,
  type PrSummary,
  type RunSummary,
  type TriageRole,
  type WorkItemId,
  type WorkspaceId,
} from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { Field, FieldGroup, FieldLabel } from "@cogwork/ui/components/field";
import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { Spinner } from "@cogwork/ui/components/spinner";
import { Textarea } from "@cogwork/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@cogwork/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { useAtom } from "@effect/atom-react";
import { RiArrowRightLine, RiFileList2Line, RiPulseLine, RiStopCircleLine } from "@remixicon/react";
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { createContext, type ReactNode, use, useRef, useState } from "react";
import { cancelRunAtom, handBackAtom, handBackTargetAtom, reclassifyAtom } from "../daemon/atoms";
import { BoardResult, useBoard } from "../features/activity-session";
import { daemonFailureMessage } from "../features/daemon-failure";
import { boardItem, needsHumanReasonLabel, runForItem, runsForItem } from "../features/feed";
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
import { Markdown } from "./markdown";
import { PullRequest } from "./pull-request";
import { RunTranscript } from "./run-transcript";
import { SurfaceTab } from "./surface-tab";

interface ItemTabState {
  readonly workspace: WorkspaceId;
  readonly item: ClassifiedItem;
  readonly run: RunSummary | null;
  readonly attempts: readonly RunSummary[];
  readonly descriptor: ItemStateDescriptor;
  readonly tabs: readonly SubTab[];
  readonly subTab: SubTabKey;
  readonly triageRole: TriageRole;
  readonly triageNote: string;
}

interface ItemTabActions {
  readonly setSubTab: (key: SubTabKey) => void;
  readonly setTriageRole: (role: TriageRole) => void;
  readonly setTriageNote: (note: string) => void;
  readonly cancel: () => void;
  readonly reclassify: (role: TriageRole, note?: string) => void;
  readonly handBack: (role: TriageRole, note?: string) => void;
}

interface MutationStatus {
  readonly pending: boolean;
  readonly error: string | null;
}

interface ItemTabMeta {
  readonly now: number;
  readonly cancel: MutationStatus;
  readonly reclassify: MutationStatus;
  readonly handBack: MutationStatus;
  readonly roleCommandPending: boolean;
  readonly triageRef: React.RefObject<HTMLDivElement | null>;
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
  item: ClassifiedItem;
  run: RunSummary | null;
  attempts: readonly RunSummary[];
  initialSubTab?: SubTabKey;
  children: ReactNode;
}) {
  const [subTab, setSubTab] = useState<SubTabKey>(
    initialSubTab ?? (run?.status === "running" ? "run" : "main"),
  );
  const [triageRole, setTriageRole] = useState<TriageRole>("ready-for-agent");
  const [triageNote, setTriageNote] = useState("");
  const [cancelResult, cancelRun] = useAtom(cancelRunAtom);
  const [reclassifyResult, runReclassify] = useAtom(reclassifyAtom);
  const [handBackResult, runHandBack] = useAtom(handBackAtom);
  const [handBackTarget, setHandBackTarget] = useAtom(handBackTargetAtom);
  const triageRef = useRef<HTMLDivElement | null>(null);
  const now = useNow();

  const descriptor = describeItemState(item, run);
  const tabs = subTabs(item.pr !== undefined);
  const resolved = resolveSubTab(subTab, tabs);
  const reclassifyStatus = mutationStatus(reclassifyResult);
  const handBackOwned = handBackTarget?.workspace === workspace && handBackTarget.workItem === item.id;
  const handBackStatus = mutationStatus(handBackResult, handBackOwned);
  const roleCommandPayload = (role: TriageRole, note?: string) => {
    const trimmedNote = note?.trim();
    return {
      payload: {
        workspace,
        workItem: item.id,
        role,
        ...(trimmedNote ? { note: trimmedNote } : {}),
      },
    };
  };

  const actions: ItemTabActions = {
    setSubTab,
    setTriageRole,
    setTriageNote,
    cancel: () => {
      if (run) cancelRun({ payload: { runId: run.id } });
    },
    reclassify: (role, note) => {
      runReclassify(roleCommandPayload(role, note));
    },
    handBack: (role, note) => {
      setHandBackTarget({ workspace, workItem: item.id });
      runHandBack(roleCommandPayload(role, note));
    },
  };

  const meta: ItemTabMeta = {
    now,
    cancel: mutationStatus(cancelResult),
    reclassify: reclassifyStatus,
    handBack: handBackStatus,
    roleCommandPending: reclassifyResult.waiting || handBackResult.waiting,
    triageRef,
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
          triageRole,
          triageNote,
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

export function ItemTitle({ title, url }: Pick<ClassifiedItem, "title" | "url">) {
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

function ApproveButton() {
  const {
    state: { item },
    actions: { reclassify },
    meta: { roleCommandPending },
  } = useItemTab();
  if (!ClassifiedItem.guards.NeedsHuman(item)) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={roleCommandPending}
      onClick={() => reclassify("ready-for-agent")}
    >
      Approve
    </Button>
  );
}

function ReclassifyButton() {
  const {
    state: { item },
    meta: { roleCommandPending, triageRef },
  } = useItemTab();
  if (!ClassifiedItem.guards.NeedsHuman(item)) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={roleCommandPending}
      onClick={() => triageRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })}
    >
      Reclassify
    </Button>
  );
}

function HandBackButton() {
  const {
    state: { item, triageRole, triageNote },
    actions: { handBack: submitHandBack },
    meta: { handBack, roleCommandPending },
  } = useItemTab();
  if (!ClassifiedItem.guards.NeedsHuman(item)) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={roleCommandPending}
      onClick={() => submitHandBack(triageRole, triageNote)}
    >
      {handBack.pending && <Spinner data-icon="inline-start" />}
      Hand back
    </Button>
  );
}

function ActionBar() {
  const {
    state: { item, descriptor },
    meta: { cancel, handBack },
  } = useItemTab();
  const hasActions = descriptor.running || ClassifiedItem.guards.NeedsHuman(item);
  if (!hasActions) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <CancelParkButton />
        <ApproveButton />
        <ReclassifyButton />
        <HandBackButton />
      </div>
      {cancel.error && <span className="text-xs text-destructive">{cancel.error}</span>}
      {handBack.error && <span className="text-xs text-destructive">{handBack.error}</span>}
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

function TriageProposal({ proposal }: { proposal: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = proposal.length > 320;
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/50 p-3">
      <Badge variant="outline" className="w-fit border-transparent bg-warning/15 text-warning">
        AI suggestion
      </Badge>
      <div className={cn("relative", long && !expanded && "max-h-32 overflow-hidden")}>
        <Markdown className="text-muted-foreground">{proposal}</Markdown>
        {long && !expanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-muted/70 to-transparent" />
        )}
      </div>
      {long && (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  );
}

// The triage control lives here only — the Attention tab launches into it.
function TriageSection({ item }: { item: NeedsHumanItem }) {
  const {
    state: { triageRole, triageNote },
    actions: { reclassify: submitReclassify, setTriageRole, setTriageNote },
    meta: { reclassify, roleCommandPending, triageRef },
  } = useItemTab();
  return (
    <section ref={triageRef} className="flex flex-col gap-3">
      <SectionLabel>Triage</SectionLabel>
      <Badge variant="outline" className="w-fit">
        {needsHumanReasonLabel[item.reason]}
      </Badge>
      {item.proposal ? (
        <TriageProposal proposal={item.proposal} />
      ) : (
        <p className="text-xs text-muted-foreground italic">No proposal recorded.</p>
      )}
      <FieldGroup>
        <Field>
          <FieldLabel>Decision</FieldLabel>
          <ToggleGroup className="flex-col items-stretch" orientation="vertical" value={[triageRole]}>
            <ToggleGroupItem
              value="ready-for-agent"
              variant="outline"
              onClick={() => setTriageRole("ready-for-agent")}
            >
              Send back to agent
            </ToggleGroupItem>
            <ToggleGroupItem value="needs-info" variant="outline" onClick={() => setTriageRole("needs-info")}>
              Needs info
            </ToggleGroupItem>
            <ToggleGroupItem
              value="ready-for-human"
              variant="outline"
              onClick={() => setTriageRole("ready-for-human")}
            >
              Ready for human
            </ToggleGroupItem>
            <ToggleGroupItem value="wontfix" variant="outline" onClick={() => setTriageRole("wontfix")}>
              Won't fix
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field>
          <FieldLabel htmlFor="triage-note">Note</FieldLabel>
          <Textarea
            id="triage-note"
            placeholder="Answer the question or explain the override…"
            value={triageNote}
            onChange={(event) => setTriageNote(event.target.value)}
          />
        </Field>
      </FieldGroup>
      <Button
        size="sm"
        className="w-fit"
        disabled={roleCommandPending}
        onClick={() => submitReclassify(triageRole, triageNote)}
      >
        {reclassify.pending && <Spinner data-icon="inline-start" />}
        Apply
      </Button>
      {reclassify.error && <span className="text-xs text-destructive">{reclassify.error}</span>}
    </section>
  );
}

function BlockersSection({ openBlockers }: { openBlockers: number }) {
  return (
    <Section title="Blockers">
      <p className="text-xs text-muted-foreground">
        {openBlockers === 1 ? "1 open blocker" : `${openBlockers} open blockers`} must clear before this item
        can run.
      </p>
    </Section>
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
                    <span className="text-muted-foreground">{attempt.stage}</span>
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
      {ClassifiedItem.guards.NeedsHuman(item) && <TriageSection item={item} />}
      {ClassifiedItem.guards.Blocked(item) && <BlockersSection openBlockers={item.openBlockers} />}
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
