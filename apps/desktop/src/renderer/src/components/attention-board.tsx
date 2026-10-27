import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Card } from "@cogwork/ui/components/card";
import { CodeBlock, CodeBlockContent } from "@cogwork/ui/components/code-block";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@cogwork/ui/components/tabs";
import { Textarea } from "@cogwork/ui/components/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@cogwork/ui/components/trace";
import { cn } from "@cogwork/ui/lib/utils";
import {
  RiArrowRightUpLine,
  RiBellLine,
  RiCloseCircleLine,
  RiErrorWarningLine,
  RiLayoutColumnLine,
  RiListUnordered,
  RiLoopLeftLine,
  RiMapPinLine,
  RiMoreLine,
  RiQuestionLine,
  RiRefreshLine,
  RiShieldCheckLine,
  RiSignpostLine,
  RiSkipForwardLine,
  RiUserLine,
} from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import { type ComponentType, createContext, type ReactNode, use, useState } from "react";
import { relativeTime } from "../features/format";
import type { CatalogIcon } from "../features/workflow-catalog";
import {
  type Answer,
  type Artifact,
  byUrgency,
  cardDescription,
  editKey,
  inputText,
  isEdited,
  type NotificationRecord,
  type ParkedItem,
  type ParkReason,
  type ParkTag,
  type PlanEdits,
  type PlanStep,
  planDigest,
  reasonLabel,
  type SkippedRecord,
  type StepState,
  skippedByWorkflow,
  skippedSummary,
  stepTitle,
  type WorkflowRef,
} from "../features/workflow-parks";
import { catalogIconFor } from "./workflow-catalog-menu";

export type AttentionLayout = "board" | "list";

export const isAttentionLayout = (value: unknown): value is AttentionLayout =>
  value === "board" || value === "list";

export interface Approval {
  readonly item: ParkedItem;
  readonly digest: string;
  readonly edits: PlanEdits;
}

export interface Rejection {
  readonly item: ParkedItem;
  readonly digest: string;
  readonly note: string;
}

export interface HandBack {
  readonly item: ParkedItem;
  readonly note: string;
}

export interface AttentionState {
  readonly parked: readonly ParkedItem[];
  readonly notifications: readonly NotificationRecord[];
  readonly skipped: readonly SkippedRecord[];
  readonly layout: AttentionLayout;
  readonly focus: string | null;
}

export interface AttentionActions {
  readonly approve: (approval: Approval) => void;
  readonly reject: (rejection: Rejection) => void;
  readonly handBack: (handBack: HandBack) => void;
  readonly dismiss: (notification: NotificationRecord) => void;
  readonly openItem: (ref: string) => void;
  readonly setFocus: (id: string | null) => void;
  readonly setLayout: (layout: AttentionLayout) => void;
}

export interface AttentionMeta {
  readonly now: number;
}

interface AttentionContextValue {
  state: AttentionState;
  actions: AttentionActions;
  meta: AttentionMeta;
}

const AttentionContext = createContext<AttentionContextValue | null>(null);

function useAttention() {
  const value = use(AttentionContext);
  if (!value) throw new Error("Attention parts must render inside Attention.Provider");
  return value;
}

function AttentionProvider({ children, ...value }: AttentionContextValue & { children: ReactNode }) {
  return <AttentionContext value={value}>{children}</AttentionContext>;
}

const scrollIntoView = (node: HTMLElement | null) => node?.scrollIntoView({ block: "nearest" });

const reasonIcons: Record<ParkTag, ComponentType<{ className?: string }>> = {
  "awaiting-approval": RiShieldCheckLine,
  stuck: RiErrorWarningLine,
  exhausted: RiCloseCircleLine,
  "write-failed": RiCloseCircleLine,
  "hop-cap": RiLoopLeftLine,
  "missing-operation": RiSignpostLine,
  "no-workspace-recognized": RiMapPinLine,
  "needs-info": RiQuestionLine,
  "ready-for-human": RiUserLine,
};

type ReasonTone = "approval" | "failure" | "setup" | "triage";

const reasonTones: Record<ParkTag, ReasonTone> = {
  "awaiting-approval": "approval",
  stuck: "failure",
  exhausted: "failure",
  "write-failed": "failure",
  "hop-cap": "setup",
  "missing-operation": "setup",
  "no-workspace-recognized": "setup",
  "needs-info": "triage",
  "ready-for-human": "triage",
};

function ReasonIcon({ reason }: { reason: ParkReason }) {
  const Icon = reasonIcons[reason.tag];
  const tone = reasonTones[reason.tag];
  return (
    <Icon
      className={cn(
        "size-4 shrink-0",
        tone === "approval" && "text-primary",
        tone === "failure" && "text-destructive",
        tone === "setup" && "text-warning",
        tone === "triage" && "text-muted-foreground",
      )}
    />
  );
}

function AppIcon({ app }: { app: CatalogIcon }) {
  const Icon = catalogIconFor(app);
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" />;
}

function When({ atMillis }: { atMillis: number }) {
  const {
    meta: { now },
  } = useAttention();
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{relativeTime(atMillis, now)}</span>
  );
}

const isIdRef = (ref: string) => /^(#|PR #|[A-Z]+-\d)/.test(ref);

function RefLabel({ itemRef }: { itemRef: string }) {
  return <span className={cn("truncate", isIdRef(itemRef) && "font-mono")}>{itemRef}</span>;
}

function ItemLink({ itemRef }: { itemRef: string }) {
  const {
    actions: { openItem },
  } = useAttention();
  return (
    <Button size="xs" variant="link" className="px-0" onClick={() => openItem(itemRef)}>
      <RefLabel itemRef={itemRef} />
    </Button>
  );
}

function ChangedMark() {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex text-muted-foreground" />}>
        <RiRefreshLine className="size-3.5" aria-label="Changed since it parked" />
      </TooltipTrigger>
      <TooltipContent>Changed since it parked</TooltipContent>
    </Tooltip>
  );
}

function WorkflowLine({ workflow, operation }: { workflow: WorkflowRef; operation: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="truncate">{workflow.name}</span>
      <span className="font-mono">r{workflow.revision}</span>
      <span aria-hidden>·</span>
      <span className="truncate">{operation}</span>
    </span>
  );
}

function AnswerChips({ answers }: { answers: readonly Answer[] }) {
  if (answers.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {answers.map((answer) => (
        <Badge key={answer.question} variant="secondary" className="font-mono font-normal">
          {answer.question}: {answer.choice}
        </Badge>
      ))}
    </span>
  );
}

function AttentionCardRoot({ id, children }: { id: string; children: ReactNode }) {
  const {
    state: { focus },
    actions: { setFocus },
  } = useAttention();
  const open = focus === id;
  return (
    <Card size="sm" className="gap-0 py-0" ref={open ? scrollIntoView : undefined}>
      <Collapsible open={open} onOpenChange={(next) => setFocus(next ? id : null)}>
        {children}
      </Collapsible>
    </Card>
  );
}

function AttentionCardSummary({ children }: { children: ReactNode }) {
  return (
    <CollapsibleTrigger className="grid w-full grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1 p-3 text-start outline-none focus-visible:bg-muted/50">
      {children}
    </CollapsibleTrigger>
  );
}

function AttentionCardIcon({ children }: { children: ReactNode }) {
  return <span className="flex h-5 items-center">{children}</span>;
}

function AttentionCardTitle({ children }: { children: ReactNode }) {
  return <span className="text-sm leading-5 font-medium">{children}</span>;
}

function AttentionCardDescription({ children }: { children: ReactNode }) {
  return <span className="col-start-2 line-clamp-2 text-sm text-muted-foreground">{children}</span>;
}

function AttentionCardMeta({ children }: { children: ReactNode }) {
  return (
    <span className="col-start-2 mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {children}
    </span>
  );
}

function AttentionCardDetail({ children }: { children: ReactNode }) {
  return (
    <CollapsibleContent className="mx-3 flex flex-col gap-3 border-t py-3">{children}</CollapsibleContent>
  );
}

const AttentionCard = {
  Root: AttentionCardRoot,
  Summary: AttentionCardSummary,
  Icon: AttentionCardIcon,
  Title: AttentionCardTitle,
  Description: AttentionCardDescription,
  Meta: AttentionCardMeta,
  Detail: AttentionCardDetail,
};

type ResponseMode = "view" | "edit" | "reject" | "hand-back";

interface ParkedContextValue {
  state: {
    item: ParkedItem;
    mode: ResponseMode;
    edits: PlanEdits;
    note: string;
    digest: string;
    edited: boolean;
  };
  actions: {
    setMode: (mode: ResponseMode) => void;
    cancel: () => void;
    setEdit: (key: string, text: string) => void;
    setNote: (text: string) => void;
    approve: () => void;
    reject: () => void;
    handBack: () => void;
  };
  meta: Record<string, never>;
}

const ParkedContext = createContext<ParkedContextValue | null>(null);

function useParked() {
  const value = use(ParkedContext);
  if (!value) throw new Error("Parked parts must render inside ParkedProvider");
  return value;
}

/** Holds the person's draft for one parked item: edited agent text and a note. Nothing else. */
function ParkedProvider({ item, children }: { item: ParkedItem; children: ReactNode }) {
  const { actions } = useAttention();
  const [mode, setMode] = useState<ResponseMode>("view");
  const [edits, setEdits] = useState<PlanEdits>({});
  const [note, setNote] = useState("");
  const digest = planDigest(item, edits);
  return (
    <ParkedContext
      value={{
        state: { item, mode, edits, note, digest, edited: isEdited(item, edits) },
        actions: {
          setMode,
          cancel: () => {
            setMode("view");
            setEdits({});
            setNote("");
          },
          setEdit: (key, text) => setEdits((current) => ({ ...current, [key]: text })),
          setNote,
          approve: () => actions.approve({ item, digest, edits }),
          reject: () => actions.reject({ item, digest, note }),
          handBack: () => actions.handBack({ item, note }),
        },
        meta: {},
      }}
    >
      {children}
    </ParkedContext>
  );
}

function StepInputs({ step }: { step: PlanStep }) {
  const {
    state: { item, mode, edits },
    actions: { setEdit },
  } = useParked();
  if (step.inputs.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {step.inputs.map((input, index) =>
        mode === "edit" ? (
          <Textarea
            key={input.id}
            aria-label={input.label}
            value={inputText(edits, item, step, input)}
            onChange={(event) => setEdit(editKey(item, step, input), event.target.value)}
          />
        ) : (
          <p
            key={input.id}
            className={cn(
              "text-sm whitespace-pre-wrap",
              index === 0 && "text-foreground",
              index > 0 && "text-muted-foreground",
            )}
          >
            {inputText(edits, item, step, input)}
          </p>
        ),
      )}
    </div>
  );
}

const traceStatus: Record<StepState, "pending" | "error" | undefined> = {
  planned: "pending",
  done: undefined,
  failed: "error",
  skipped: "pending",
};

const stepDescription = (step: PlanStep) =>
  step.state === "skipped" ? step.note : [step.target, ...step.parameters].filter(Boolean).join(" · ");

function StepLine({ step }: { step: PlanStep }) {
  return (
    <TraceLine status={traceStatus[step.state]}>
      <TraceIcon>
        <AppIcon app={step.app} />
      </TraceIcon>
      <TraceTitle>{stepTitle(step)}</TraceTitle>
      <TraceDescription>{stepDescription(step)}</TraceDescription>
      {step.state === "skipped" && (
        <TraceIcon>
          <RiSkipForwardLine />
        </TraceIcon>
      )}
    </TraceLine>
  );
}

function StepDetail({ step }: { step: PlanStep }) {
  if (step.state === "failed" && step.note) {
    return (
      <CodeBlock size="sm" variant="destructive">
        <CodeBlockContent wrap>{step.note}</CodeBlockContent>
      </CodeBlock>
    );
  }
  return <StepInputs step={step} />;
}

const hasStepDetail = (step: PlanStep) =>
  step.inputs.length > 0 || (step.state === "failed" && step.note !== null);

/** One Trace line per step. A line with agent text or an error opens to show it; Edit opens them all. */
function ParkedPlan() {
  const {
    state: { item, mode },
  } = useParked();
  if (item.plan.length === 0) return null;
  return (
    <Trace>
      {item.plan.map((step) =>
        hasStepDetail(step) ? (
          <TraceCollapsible
            key={`${step.id}:${mode}`}
            defaultOpen={mode === "edit" || step.state === "failed"}
          >
            <TraceCollapsibleTrigger>
              <StepLine step={step} />
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
              <StepDetail step={step} />
            </TraceCollapsibleContent>
          </TraceCollapsible>
        ) : (
          <StepLine key={step.id} step={step} />
        ),
      )}
    </Trace>
  );
}

function NoteCommand({
  confirm,
  variant,
  onConfirm,
}: {
  confirm: string;
  variant: "default" | "destructive";
  onConfirm: () => void;
}) {
  const {
    state: { note },
    actions: { setNote, cancel },
  } = useParked();
  return (
    <div className="flex w-full flex-col gap-2">
      <Textarea
        aria-label="Note"
        placeholder="Note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        <Button size="sm" variant={variant} onClick={onConfirm}>
          {confirm}
        </Button>
      </div>
    </div>
  );
}

function ApprovalMenu() {
  const {
    actions: { setMode },
  } = useParked();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button aria-label="More" size="icon-sm" variant="ghost" />}>
        <RiMoreLine />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => setMode("edit")}>Edit</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setMode("hand-back")}>Hand back</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A pending approval is a prompt, not activity: one Item under the plan it names. */
function ApprovalPrompt() {
  const {
    state: { item, mode, digest, edited },
    actions: { setMode, cancel, approve, reject, handBack },
  } = useParked();
  if (mode === "reject") return <NoteCommand confirm="Reject" variant="destructive" onConfirm={reject} />;
  if (mode === "hand-back") return <NoteCommand confirm="Hand back" variant="default" onConfirm={handBack} />;
  const steps = item.plan.filter((step) => step.state !== "skipped").length;
  return (
    <Item variant="muted" size="sm">
      <ItemContent>
        <ItemTitle>{`Run ${steps} ${steps === 1 ? "step" : "steps"}?`}</ItemTitle>
        <ItemDescription className={cn("font-mono", edited && "text-foreground")}>{digest}</ItemDescription>
      </ItemContent>
      <ItemActions>
        {mode === "edit" && (
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        )}
        {mode === "view" && <ApprovalMenu />}
        {mode === "view" && (
          <Button size="sm" variant="outline" onClick={() => setMode("reject")}>
            Reject
          </Button>
        )}
        <Button size="sm" onClick={approve}>
          Approve
        </Button>
      </ItemActions>
    </Item>
  );
}

function HandBackCommands() {
  const {
    state: { item, mode },
    actions: { setMode, handBack },
  } = useParked();
  if (mode === "hand-back") return <NoteCommand confirm="Hand back" variant="default" onConfirm={handBack} />;
  return (
    <div className="flex items-center justify-end gap-1.5">
      {item.reason.tag === "missing-operation" && (
        <Button
          size="sm"
          variant="ghost"
          nativeButton={false}
          render={<Link to="/workflows/$workflowId" params={{ workflowId: item.workflow.id }} />}
        >
          Edit Workflow
        </Button>
      )}
      <Button size="sm" onClick={() => setMode("hand-back")}>
        Hand back
      </Button>
    </div>
  );
}

function OpenCommand() {
  const {
    state: { item },
  } = useParked();
  const {
    actions: { openItem },
  } = useAttention();
  return (
    <div className="flex justify-end">
      <Button size="sm" variant="outline" onClick={() => openItem(item.ref)}>
        Open {item.ref}
      </Button>
    </div>
  );
}

function ParkedCommands() {
  const {
    state: { item },
  } = useParked();
  if (item.commands.includes("approve")) return <ApprovalPrompt />;
  if (item.commands.includes("hand-back")) return <HandBackCommands />;
  return <OpenCommand />;
}

/** One line naming the root; it opens to every hop down to this Operation. */
function LineageTrace({ item }: { item: ParkedItem }) {
  const root = item.lineage[0];
  if (!root) return null;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon>
            <AppIcon app={root.app} />
          </TraceIcon>
          <TraceTitle>From {root.label}</TraceTitle>
          <TraceDescription>
            {item.workflow.name} r{item.workflow.revision} · {item.operation}
          </TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Trace>
          {item.lineage.map((hop, index) => (
            <TraceLine key={`${hop.label}:${index}`}>
              <TraceIcon>
                <AppIcon app={hop.app} />
              </TraceIcon>
              <TraceTitle>{hop.label}</TraceTitle>
              {hop.workflow && <TraceDescription>{hop.workflow}</TraceDescription>}
            </TraceLine>
          ))}
          <TraceLine>
            <TraceIcon>
              <AppIcon app="operation" />
            </TraceIcon>
            <TraceTitle className="text-foreground">{item.operation}</TraceTitle>
            <TraceDescription>{item.workflow.name}</TraceDescription>
          </TraceLine>
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function FailureBlock({ item }: { item: ParkedItem }) {
  if (item.reason.tag !== "exhausted") return null;
  return (
    <CodeBlock size="sm" variant="destructive">
      <CodeBlockContent wrap>{item.reason.failure}</CodeBlockContent>
    </CodeBlock>
  );
}

function ParkedCard({ item }: { item: ParkedItem }) {
  const description = cardDescription(item);
  return (
    <AttentionCard.Root id={item.id}>
      <AttentionCard.Summary>
        <AttentionCard.Icon>
          <ReasonIcon reason={item.reason} />
        </AttentionCard.Icon>
        <AttentionCard.Title>{item.title}</AttentionCard.Title>
        <AttentionCard.Description>{description}</AttentionCard.Description>
        <AttentionCard.Meta>
          <span className="text-foreground">{reasonLabel(item)}</span>
          <span aria-hidden>·</span>
          <When atMillis={item.parkedAtMillis} />
          {item.changedSinceParked && <ChangedMark />}
          <span className="ms-auto" />
          <AppIcon app={item.source} />
          <RefLabel itemRef={item.ref} />
        </AttentionCard.Meta>
      </AttentionCard.Summary>
      <AttentionCard.Detail>
        <LineageTrace item={item} />
        {description !== item.summary && <p className="text-sm">{item.summary}</p>}
        <FailureBlock item={item} />
        <ParkedProvider item={item}>
          <ParkedPlan />
          <ParkedCommands />
        </ParkedProvider>
      </AttentionCard.Detail>
    </AttentionCard.Root>
  );
}

/** The Sources pattern: one line that opens to a link for each artifact. */
function ArtifactTrace({ artifacts }: { artifacts: readonly Artifact[] }) {
  if (artifacts.length === 0) return null;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceTitle>{`Created ${artifacts.length} ${artifacts.length === 1 ? "artifact" : "artifacts"}`}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Trace>
          {artifacts.map((artifact) => (
            <a key={artifact.label} href={artifact.url} target="_blank" rel="noreferrer">
              <TraceLine>
                <TraceIcon>
                  <AppIcon app={artifact.app} />
                </TraceIcon>
                <TraceTitle>
                  {artifact.label}
                  <span className="sr-only"> (opens in a new tab)</span>
                </TraceTitle>
                <TraceIcon>
                  <RiArrowRightUpLine />
                </TraceIcon>
              </TraceLine>
            </a>
          ))}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function NotificationCard({ notification }: { notification: NotificationRecord }) {
  const {
    actions: { dismiss },
  } = useAttention();
  return (
    <AttentionCard.Root id={notification.id}>
      <AttentionCard.Summary>
        <AttentionCard.Icon>
          <RiBellLine className="size-4 shrink-0 text-muted-foreground" />
        </AttentionCard.Icon>
        <AttentionCard.Title>{notification.title}</AttentionCard.Title>
        <AttentionCard.Description>{notification.summary}</AttentionCard.Description>
        <AttentionCard.Meta>
          <When atMillis={notification.atMillis} />
          <span className="ms-auto" />
          <AppIcon app={notification.source} />
          <RefLabel itemRef={notification.ref} />
        </AttentionCard.Meta>
      </AttentionCard.Summary>
      <AttentionCard.Detail>
        <WorkflowLine workflow={notification.workflow} operation={notification.operation} />
        <AnswerChips answers={notification.answers} />
        <ArtifactTrace artifacts={notification.artifacts} />
        <span className="flex items-center justify-between">
          <ItemLink itemRef={notification.ref} />
          <Button size="sm" variant="ghost" onClick={() => dismiss(notification)}>
            Dismiss
          </Button>
        </span>
      </AttentionCard.Detail>
    </AttentionCard.Root>
  );
}

function SkippedCard({ workflow, records }: { workflow: WorkflowRef; records: readonly SkippedRecord[] }) {
  const latest = Math.max(...records.map((record) => record.atMillis));
  return (
    <AttentionCard.Root id={`workflow:${workflow.id}`}>
      <AttentionCard.Summary>
        <AttentionCard.Icon>
          <RiSkipForwardLine className="size-4 shrink-0 text-muted-foreground" />
        </AttentionCard.Icon>
        <AttentionCard.Title>{workflow.name}</AttentionCard.Title>
        <AttentionCard.Description>{records[0]?.reason}</AttentionCard.Description>
        <AttentionCard.Meta>
          <span className="text-foreground">{skippedSummary(records)}</span>
          <span aria-hidden>·</span>
          <When atMillis={latest} />
        </AttentionCard.Meta>
      </AttentionCard.Summary>
      <AttentionCard.Detail>
        <ul className="flex flex-col gap-2.5">
          {records.map((record) => (
            <li key={record.id} className="flex items-start gap-2">
              <span className="flex h-5 items-center">
                <AppIcon app={record.app} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{record.what}</span>
                <span className="text-xs text-muted-foreground">{record.reason}</span>
              </span>
              <When atMillis={record.atMillis} />
            </li>
          ))}
        </ul>
      </AttentionCard.Detail>
    </AttentionCard.Root>
  );
}

function Lane({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const {
    state: { layout },
  } = useAttention();
  return (
    <section className="flex flex-col gap-1 rounded-2xl bg-muted/60 p-1">
      <h2
        className={cn(
          "flex h-8 items-center gap-2 px-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase",
          layout === "board" && "justify-center",
        )}
      >
        {title}
        <Badge variant="secondary" className="tabular-nums">
          {count}
        </Badge>
      </h2>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

function AttentionLanes() {
  const {
    state: { parked, notifications, skipped, layout },
  } = useAttention();
  const skippedGroups = skippedByWorkflow(skipped);
  return (
    <div
      className={cn(
        layout === "board" && "grid grid-cols-3 items-start gap-2",
        layout === "list" && "mx-auto flex w-full max-w-3xl flex-col gap-3",
      )}
    >
      <Lane title="Needs you" count={parked.length}>
        {byUrgency(parked).map((item) => (
          <ParkedCard key={item.id} item={item} />
        ))}
      </Lane>
      <Lane title="Notified" count={notifications.length}>
        {notifications.map((notification) => (
          <NotificationCard key={notification.id} notification={notification} />
        ))}
      </Lane>
      <Lane title="Skipped" count={skippedGroups.length}>
        {skippedGroups.map((group) => (
          <SkippedCard key={group.workflow.id} workflow={group.workflow} records={group.records} />
        ))}
      </Lane>
    </div>
  );
}

function AttentionFrame({ children }: { children: ReactNode }) {
  const {
    state: { layout },
    actions: { setLayout },
  } = useAttention();
  return (
    <Tabs
      value={layout}
      onValueChange={(next) => {
        if (isAttentionLayout(next)) setLayout(next);
      }}
      className="gap-4 px-6 pt-5 pb-6"
    >
      <header className="flex items-center justify-between">
        <h1 className="text-base font-medium">Attention</h1>
        <TabsList>
          <TabsTrigger value="board">
            <RiLayoutColumnLine />
            Board
          </TabsTrigger>
          <TabsTrigger value="list">
            <RiListUnordered />
            List
          </TabsTrigger>
        </TabsList>
      </header>
      <TabsContent value="board">{children}</TabsContent>
      <TabsContent value="list">{children}</TabsContent>
    </Tabs>
  );
}

export const Attention = {
  Provider: AttentionProvider,
  Frame: AttentionFrame,
  Lanes: AttentionLanes,
};
