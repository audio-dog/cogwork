import type {
  ClassifiedItem,
  NeedsHumanItem,
  PrSummary,
  RunSummary,
  TriageRole,
  WorkItemId,
  WorkspaceId,
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
import {
  RiArrowRightLine,
  RiExternalLinkLine,
  RiFileList2Line,
  RiPulseLine,
  RiStopCircleLine,
} from "@remixicon/react";
import * as Cause from "effect/Cause";
import { createContext, type ReactNode, use, useRef, useState } from "react";
import { cancelRunAtom, reclassifyAtom } from "../daemon/atoms";
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
import { statusLine, useRunActivity } from "../features/run-activity";
import { useBoard } from "../features/use-board";
import { useNow } from "../features/use-now";
import type { ItemSelection } from "../store/chrome";
import { useRightPanelStore } from "../store/right-panel";
import { PrChecksBadge, PrDivergenceBadge, PrReviewBadge } from "./badges";
import { Markdown } from "./markdown";
import { PullRequest } from "./pull-request";
import { RunDrillIn } from "./run-drill-in";
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
}

interface ItemTabMeta {
  readonly now: number;
  readonly cancelPending: boolean;
  readonly cancelError: string | null;
  readonly reclassifyPending: boolean;
  readonly reclassifyError: string | null;
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
  const [reclassifyResult, reclassify] = useAtom(reclassifyAtom);
  const triageRef = useRef<HTMLDivElement | null>(null);
  const now = useNow();

  const descriptor = describeItemState(item, run);
  const tabs = subTabs(item.pr !== undefined);
  const resolved = resolveSubTab(subTab, tabs);

  const actions: ItemTabActions = {
    setSubTab,
    setTriageRole,
    setTriageNote,
    cancel: () => {
      if (run) cancelRun({ payload: { runId: run.id } });
    },
    reclassify: (role, note) =>
      reclassify({
        payload: { workspace, workItem: item.id, role, ...(note ? { note } : {}) },
      }),
  };

  const meta: ItemTabMeta = {
    now,
    cancelPending: cancelResult.waiting,
    cancelError: cancelResult._tag === "Failure" ? Cause.pretty(cancelResult.cause) : null,
    reclassifyPending: reclassifyResult.waiting,
    reclassifyError: reclassifyResult._tag === "Failure" ? Cause.pretty(reclassifyResult.cause) : null,
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
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 self-start rounded-full px-2 py-0.5 text-xs font-medium",
        descriptor.tone === "live" && "bg-primary/15 text-primary",
        descriptor.tone === "attention" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
        descriptor.tone === "ready" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        descriptor.tone === "muted" && "bg-muted text-muted-foreground",
      )}
    >
      {descriptor.running && <RiPulseLine className="size-3.5 animate-pulse" />}
      {descriptor.label}
    </span>
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
      <h1 className="text-base font-semibold">{item.title}</h1>
      <StateBadge descriptor={descriptor} />
    </div>
  );
}

function CancelParkButton() {
  const {
    state: { descriptor },
    actions: { cancel },
    meta: { cancelPending },
  } = useItemTab();
  if (!descriptor.running) return null;
  return (
    <Button size="sm" variant="outline" disabled={cancelPending} onClick={cancel}>
      {cancelPending ? <Spinner data-icon="inline-start" /> : <RiStopCircleLine data-icon="inline-start" />}
      Cancel &amp; park
    </Button>
  );
}

function ApproveButton() {
  const {
    state: { item },
    actions: { reclassify },
    meta: { reclassifyPending },
  } = useItemTab();
  if (item._tag !== "NeedsHuman") return null;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={reclassifyPending}
      onClick={() => reclassify("ready-for-agent")}
    >
      Approve
    </Button>
  );
}

function ReclassifyButton() {
  const {
    state: { item },
    meta: { triageRef },
  } = useItemTab();
  if (item._tag !== "NeedsHuman") return null;
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => triageRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })}
    >
      Reclassify
    </Button>
  );
}

function OpenOnGitHubButton() {
  const {
    state: { item },
  } = useItemTab();
  if (!item.pr) return null;
  return (
    <Button size="sm" variant="outline" render={<a href={item.pr.url} rel="noreferrer" target="_blank" />}>
      Open on GitHub
      <RiExternalLinkLine data-icon="inline-end" />
    </Button>
  );
}

function ActionBar() {
  const {
    state: { item, descriptor },
    meta: { cancelError },
  } = useItemTab();
  const hasActions = descriptor.running || item._tag === "NeedsHuman" || item.pr !== undefined;
  if (!hasActions) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <CancelParkButton />
        <ApproveButton />
        <ReclassifyButton />
        <OpenOnGitHubButton />
      </div>
      {cancelError && <span className="text-xs text-destructive">{cancelError}</span>}
    </div>
  );
}

function RunningAffordance({ run }: { run: RunSummary }) {
  const {
    actions: { setSubTab },
  } = useItemTab();
  const result = useRunActivity(run.id);
  const activities = result._tag === "Success" ? result.value.items : [];
  const line = statusLine(activities, run.status);
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

const triageRoles: ReadonlyArray<{ readonly role: TriageRole; readonly label: string }> = [
  { role: "ready-for-agent", label: "Send back to agent" },
  { role: "needs-info", label: "Needs info" },
  { role: "ready-for-human", label: "Ready for human" },
  { role: "wontfix", label: "Won't fix" },
];

function TriageProposal({ proposal }: { proposal: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = proposal.length > 320;
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/50 p-3">
      <span className="w-fit rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-400">
        AI suggestion
      </span>
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
    actions: { reclassify, setTriageRole, setTriageNote },
    meta: { reclassifyPending, reclassifyError, triageRef },
  } = useItemTab();

  const trimmed = triageNote.trim();
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
          <ToggleGroup
            className="flex-col items-stretch"
            orientation="vertical"
            value={[triageRole]}
            onValueChange={(value) => {
              const next = triageRoles.find((option) => option.role === value[0]);
              if (next) setTriageRole(next.role);
            }}
          >
            {triageRoles.map(({ role: value, label }) => (
              <ToggleGroupItem key={value} value={value} variant="outline">
                {label}
              </ToggleGroupItem>
            ))}
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
        disabled={reclassifyPending}
        onClick={() => reclassify(triageRole, trimmed || undefined)}
      >
        {reclassifyPending && <Spinner data-icon="inline-start" />}
        Apply
      </Button>
      {reclassifyError && <span className="text-xs text-destructive">{reclassifyError}</span>}
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
                        "font-medium capitalize",
                        tone === "succeeded" && "text-emerald-600 dark:text-emerald-400",
                        tone === "failed" && "text-destructive",
                        tone === "abandoned" && "text-muted-foreground",
                      )}
                    >
                      {attempt.status}
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
                    <CollapsibleContent className="mt-2 h-96 rounded-md border">
                      <RunDrillIn run={attempt} />
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
      {item._tag === "NeedsHuman" && <TriageSection item={item} />}
      {item._tag === "Blocked" && <BlockersSection openBlockers={item.openBlockers} />}
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
  if (!run) {
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
  }
  if (run.status !== "running") {
    return (
      <SubTabBody>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No live run</EmptyTitle>
            <EmptyDescription>The latest completed run is shown below.</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <div className="h-96 rounded-md border">
          <RunDrillIn run={run} />
        </div>
      </SubTabBody>
    );
  }
  return <RunDrillIn run={run} />;
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

export function ItemTab({
  selection,
}: {
  selection: ItemSelection & { runId?: RunSummary["id"]; run?: RunSummary };
}) {
  const result = useBoard();
  if (result._tag !== "Success") return <ItemGone />;

  const { board } = result;
  const entry = boardItem(board, selection.workspace, selection.workItem);
  if (!entry) return <ItemGone />;

  const selectedRun = selectedRunForItem(
    (selection.runId ? board.runs.get(selection.runId) : null) ?? selection.run,
    selection.workspace,
    selection.workItem,
  );
  const run = selectedRun ?? runForItem(board, selection.workspace, selection.workItem);
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

  return (
    <SurfaceTab.Root active={active}>
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
      <SurfaceTab.Close label={workItem} onClick={() => closeSurface(id)} />
    </SurfaceTab.Root>
  );
}
