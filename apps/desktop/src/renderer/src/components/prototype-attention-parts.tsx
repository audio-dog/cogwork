import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { CodeBlock, CodeBlockContent } from "@cogwork/ui/components/code-block";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";
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
  RiArrowRightSLine,
  RiArrowRightUpLine,
  RiBellLine,
  RiCloseCircleLine,
  RiErrorWarningLine,
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
import { type ComponentType, createContext, type ReactNode, use } from "react";
import { relativeTime } from "../features/format";
import {
  type Answer,
  type Artifact,
  editKey,
  inputText,
  isEdited,
  type LineageHop,
  type NotificationRecord,
  notifications,
  type ParkedItem,
  type ParkReason,
  type ParkTag,
  type PlanStep,
  parkedItems,
  planDigest,
  skippedRecords,
  type WorkflowRef,
} from "../features/prototype-attention-data";
import { type ResponseMode, usePrototypeAttention } from "../features/prototype-attention-store";
import { catalogIconFor } from "./workflow-catalog-menu";

/** PROTOTYPE — issue #794. Parts the attention polish versions share. */

export type AttentionLayout = "board" | "list";

interface AttentionViewValue {
  focus: string | null;
  setFocus: (id: string | null) => void;
  layout: AttentionLayout;
}

const AttentionViewContext = createContext<AttentionViewValue | null>(null);

export function AttentionViewProvider({ children, ...value }: AttentionViewValue & { children: ReactNode }) {
  return <AttentionViewContext value={value}>{children}</AttentionViewContext>;
}

export function useAttentionView() {
  const value = use(AttentionViewContext);
  if (!value) throw new Error("useAttentionView must render inside AttentionViewProvider");
  return value;
}

export const scrollIntoView = (node: HTMLElement | null) => node?.scrollIntoView({ block: "nearest" });

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

const reasonLabels: Record<ParkTag, string> = {
  "awaiting-approval": "Approval",
  stuck: "Stuck",
  exhausted: "Failed",
  "write-failed": "Write failed",
  "hop-cap": "Hop cap",
  "missing-operation": "Missing Operation",
  "no-workspace-recognized": "No Workspace",
  "needs-info": "Needs info",
  "ready-for-human": "Needs a person",
};

export const reasonLabel = (item: ParkedItem) => reasonLabels[item.reason.tag];

export const reasonDetail = (item: ParkedItem) => {
  const { reason } = item;
  if (reason.tag === "stuck") return reason.summary;
  if (reason.tag === "exhausted") return `${reason.failure} · ${reason.attempts} attempts`;
  if (reason.tag === "write-failed") return `${reason.step}: ${reason.error}`;
  if (reason.tag === "hop-cap") return `${reason.hops} hops from ${item.lineage[0]?.label ?? "the root"}`;
  if (reason.tag === "missing-operation") {
    return `r${item.workflow.revision} has no “${reason.operation}”`;
  }
  return null;
};

/** What a card shows under its title: the reason when it has text, else the element summary. */
export const cardDescription = (item: ParkedItem) => reasonDetail(item) ?? item.summary;

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

export function ReasonIcon({ reason, className }: { reason: ParkReason; className?: string }) {
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
        className,
      )}
    />
  );
}

export function NotificationIcon({ className }: { className?: string }) {
  return <RiBellLine className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}

export function AppIcon({ app, className }: { app: LineageHop["app"]; className?: string }) {
  const Icon = catalogIconFor(app);
  return <Icon className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}

export function WorkflowLine({ workflow, operation }: { workflow: WorkflowRef; operation?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="truncate">{workflow.name}</span>
      <span className="font-mono">r{workflow.revision}</span>
      {operation && (
        <>
          <span aria-hidden>·</span>
          <span className="truncate">{operation}</span>
        </>
      )}
    </span>
  );
}

export function When({ atMillis }: { atMillis: number }) {
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{relativeTime(atMillis)}</span>
  );
}

export function ChangedMark() {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex text-muted-foreground" />}>
        <RiRefreshLine className="size-3.5" aria-label="Changed since it parked" />
      </TooltipTrigger>
      <TooltipContent>Changed since it parked</TooltipContent>
    </Tooltip>
  );
}

export function AnswerChips({ answers }: { answers: readonly Answer[] }) {
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

function HopLabel({ hop }: { hop: LineageHop }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <AppIcon app={hop.app} />
      <span className={cn("truncate", hop.kind === "artifact" && "font-mono")}>{hop.label}</span>
    </span>
  );
}

const isIdRef = (ref: string) => /^(#|PR #|[A-Z]+-\d)/.test(ref);

export function RefLabel({ itemRef }: { itemRef: string }) {
  return <span className={cn("truncate", isIdRef(itemRef) && "font-mono")}>{itemRef}</span>;
}

/** The Workflow and its revision, then root first and the item's own Operation last. */
export function Provenance({ item }: { item: ParkedItem }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-muted-foreground">
      <span className="text-foreground/80">{item.workflow.name}</span>
      <span className="font-mono">r{item.workflow.revision}</span>
      <span aria-hidden className="px-0.5">
        ·
      </span>
      <LineageHops item={item} />
    </span>
  );
}

function LineageHops({ item }: { item: ParkedItem }) {
  return (
    <>
      {item.lineage.map((hop, index) => (
        <span key={`${hop.label}:${index}`} className="flex items-center gap-1">
          {hop.workflow && hop.workflow !== item.workflow.name && (
            <span className="text-foreground/70">{hop.workflow}:</span>
          )}
          <HopLabel hop={hop} />
          <RiArrowRightSLine className="size-3.5 shrink-0" />
        </span>
      ))}
      <span className="font-medium text-foreground">{item.operation}</span>
    </>
  );
}

interface ParkedContextValue {
  state: { item: ParkedItem; mode: ResponseMode; digest: string; edited: boolean; note: string };
  actions: {
    setMode: (mode: ResponseMode) => void;
    cancel: () => void;
    setEdit: (key: string, text: string) => void;
    setNote: (text: string) => void;
    approve: () => void;
    reject: () => void;
    handBack: () => void;
  };
  meta: { edits: Readonly<Record<string, string>> };
}

const ParkedContext = createContext<ParkedContextValue | null>(null);

function useParked() {
  const value = use(ParkedContext);
  if (!value) throw new Error("Parked parts must render inside Parked.Provider");
  return value;
}

function ParkedProvider({ item, children }: { item: ParkedItem; children: ReactNode }) {
  const store = usePrototypeAttention();
  const edits = store.edits;
  return (
    <ParkedContext
      value={{
        state: {
          item,
          mode: store.modes[item.id] ?? "view",
          digest: planDigest(item, edits),
          edited: isEdited(item, edits),
          note: store.notes[item.id] ?? "",
        },
        actions: {
          setMode: (mode) => store.setMode(item, mode),
          cancel: () => store.cancel(item),
          setEdit: store.setEdit,
          setNote: (text) => store.setNote(item, text),
          approve: () => store.approve(item),
          reject: () => store.reject(item),
          handBack: () => store.handBack(item),
        },
        meta: { edits },
      }}
    >
      {children}
    </ParkedContext>
  );
}

function StepInputs({ step }: { step: PlanStep }) {
  const {
    state: { item, mode },
    actions: { setEdit },
    meta: { edits },
  } = useParked();
  if (step.inputs.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {step.inputs.map((agentInput, index) =>
        mode === "edit" ? (
          <Textarea
            key={agentInput.id}
            aria-label={agentInput.label}
            value={inputText(edits, item, step, agentInput)}
            onChange={(event) => setEdit(editKey(item, step, agentInput), event.target.value)}
          />
        ) : (
          <p
            key={agentInput.id}
            className={cn(
              "text-sm whitespace-pre-wrap",
              index === 0 && "text-foreground",
              index > 0 && "text-muted-foreground",
            )}
          >
            {inputText(edits, item, step, agentInput)}
          </p>
        ),
      )}
    </div>
  );
}

function StepDot({ step }: { step: PlanStep }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative z-10 size-2 shrink-0 rounded-full ring-4 ring-card",
        step.state === "planned" && "bg-foreground/40",
        step.state === "done" && "bg-success",
        step.state === "failed" && "bg-destructive",
        step.state === "skipped" && "border border-muted-foreground/50 bg-card",
      )}
    />
  );
}

function StepLine({ step }: { step: PlanStep }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
      <AppIcon app={step.app} />
      <span className={cn("truncate", step.state === "skipped" && "text-muted-foreground line-through")}>
        {step.action}
      </span>
      {step.parameters.map((parameter) => (
        <Badge key={parameter} variant="outline" className="font-normal">
          {parameter}
        </Badge>
      ))}
      <span className="ms-auto shrink-0 font-mono text-xs text-muted-foreground">{step.target}</span>
    </span>
  );
}

function StepNote({ step }: { step: PlanStep }) {
  if (!step.note) return null;
  return (
    <span
      className={cn(
        "text-xs",
        step.state === "failed" && "text-destructive",
        step.state !== "failed" && "text-muted-foreground",
      )}
    >
      {step.note}
    </span>
  );
}

/** The plan as a timeline: one dot per step, the agent's text under each step. */
function PlanTimeline() {
  const {
    state: { item },
  } = useParked();
  if (item.plan.length === 0) return null;
  return (
    <ol className="relative flex flex-col gap-3 before:absolute before:top-2.5 before:bottom-2.5 before:left-[3.5px] before:w-px before:bg-border">
      {item.plan.map((step) => (
        <li key={step.id} className="flex gap-3">
          <span className="flex h-5 items-center">
            <StepDot step={step} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <StepLine step={step} />
            <StepNote step={step} />
            <StepInputs step={step} />
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The plan as numbered rows inside one muted panel. */
function PlanPanel() {
  const {
    state: { item },
  } = useParked();
  if (item.plan.length === 0) return null;
  return (
    <ol className="flex flex-col divide-y rounded-lg bg-muted/50">
      {item.plan.map((step, index) => (
        <li key={step.id} className="flex gap-2.5 px-3 py-2.5">
          <span className="w-3 shrink-0 pt-0.5 font-mono text-xs text-muted-foreground">{index + 1}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <StepLine step={step} />
            <StepNote step={step} />
            <StepInputs step={step} />
          </div>
        </li>
      ))}
    </ol>
  );
}

/** One line per step, no agent text: enough to see what Approve commits to. */
function PlanOutline() {
  const {
    state: { item },
  } = useParked();
  if (item.plan.length === 0) return null;
  return (
    <ol className="flex flex-col gap-1">
      {item.plan.map((step) => (
        <li key={step.id} className="flex items-center gap-2">
          <StepDot step={step} />
          <StepLine step={step} />
        </li>
      ))}
    </ol>
  );
}

function ParkedDigest() {
  const {
    state: { item, digest, edited },
  } = useParked();
  if (item.reason.tag !== "awaiting-approval") return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "font-mono text-xs",
              edited && "text-foreground",
              !edited && "text-muted-foreground",
            )}
          />
        }
      >
        {digest}
      </TooltipTrigger>
      <TooltipContent>{`Plan digest · built on ${item.reason.builtOn}`}</TooltipContent>
    </Tooltip>
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

function ApprovalCommands() {
  const {
    state: { mode },
    actions: { setMode, cancel, approve, reject, handBack },
  } = useParked();
  if (mode === "reject") return <NoteCommand confirm="Reject" variant="destructive" onConfirm={reject} />;
  if (mode === "hand-back") return <NoteCommand confirm="Hand back" variant="default" onConfirm={handBack} />;
  if (mode === "edit") {
    return (
      <div className="flex items-center gap-2">
        <ParkedDigest />
        <span className="ms-auto" />
        <Button size="sm" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={approve}>
          Approve
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <ParkedDigest />
      <span className="ms-auto" />
      <Button size="sm" variant="ghost" onClick={() => setMode("edit")}>
        Edit
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setMode("hand-back")}>
        Hand back
      </Button>
      <Button size="sm" variant="outline" onClick={() => setMode("reject")}>
        Reject
      </Button>
      <Button size="sm" onClick={approve}>
        Approve
      </Button>
    </div>
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
  const open = usePrototypeAttention((state) => state.open);
  return (
    <div className="flex justify-end">
      <Button size="sm" variant="outline" onClick={() => open(item.ref)}>
        Open {item.ref}
      </Button>
    </div>
  );
}

function ParkedCommands() {
  const {
    state: { item },
  } = useParked();
  if (item.commands.includes("approve")) return <ApprovalCommands />;
  if (item.commands.includes("hand-back")) return <HandBackCommands />;
  return <OpenCommand />;
}

const pastTenses: Record<string, string> = {
  Add: "Added",
  Close: "Closed",
  Comment: "Commented",
  Create: "Created",
  Notify: "Notified",
  Open: "Opened",
  Reply: "Replied",
  Request: "Requested",
  Send: "Sent",
};

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Trace titles say what happened: "Create an issue", "Created an issue", "Failed to add a label". */
const stepTitle = (step: PlanStep) => {
  const [verb = "", ...rest] = step.action.split(" ");
  if (step.state === "failed") return `Failed to ${lowerFirst(step.action)}`;
  if (step.state === "done") return [pastTenses[verb] ?? verb, ...rest].join(" ");
  return step.action;
};

const traceStatus: Record<PlanStep["state"], "pending" | "error" | undefined> = {
  planned: "pending",
  done: undefined,
  failed: "error",
  skipped: "pending",
};

function StepTraceLine({ step }: { step: PlanStep }) {
  return (
    <TraceLine status={traceStatus[step.state]}>
      <TraceIcon>
        <AppIcon app={step.app} />
      </TraceIcon>
      <TraceTitle>{stepTitle(step)}</TraceTitle>
      <TraceDescription>
        {step.state === "skipped" ? step.note : [step.target, ...step.parameters].filter(Boolean).join(" · ")}
      </TraceDescription>
      {step.state === "skipped" && (
        <TraceIcon>
          <RiSkipForwardLine />
        </TraceIcon>
      )}
    </TraceLine>
  );
}

function StepTraceDetail({ step }: { step: PlanStep }) {
  if (step.state === "failed" && step.note) {
    return (
      <CodeBlock size="sm" variant="destructive">
        <CodeBlockContent wrap>{step.note}</CodeBlockContent>
      </CodeBlock>
    );
  }
  return <StepInputs step={step} />;
}

const hasTraceDetail = (step: PlanStep) => step.inputs.length > 0 || (step.state === "failed" && step.note);

/** The plan as Trace lines. A line with agent text or an error opens to show it; Edit opens them all. */
function PlanTrace() {
  const {
    state: { item, mode },
  } = useParked();
  if (item.plan.length === 0) return null;
  return (
    <Trace>
      {item.plan.map((step) =>
        hasTraceDetail(step) ? (
          <TraceCollapsible
            key={`${step.id}:${mode}`}
            defaultOpen={mode === "edit" || step.state === "failed"}
          >
            <TraceCollapsibleTrigger>
              <StepTraceLine step={step} />
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
              <StepTraceDetail step={step} />
            </TraceCollapsibleContent>
          </TraceCollapsible>
        ) : (
          <StepTraceLine key={step.id} step={step} />
        ),
      )}
    </Trace>
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
        {mode === "edit" ? (
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        ) : (
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
        )}
        {mode !== "edit" && (
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

function ParkedPrompt() {
  const {
    state: { item },
  } = useParked();
  if (item.commands.includes("approve")) return <ApprovalPrompt />;
  return <ParkedCommands />;
}

export const Parked = {
  Provider: ParkedProvider,
  Timeline: PlanTimeline,
  Panel: PlanPanel,
  Outline: PlanOutline,
  Trace: PlanTrace,
  Commands: ParkedCommands,
  Prompt: ParkedPrompt,
};

/** One collapsible line naming the root; it opens to every hop down to this Operation. */
export function LineageTrace({ item }: { item: ParkedItem }) {
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

export function FailureBlock({ item }: { item: ParkedItem }) {
  if (item.reason.tag !== "exhausted") return null;
  return (
    <CodeBlock size="sm" variant="destructive">
      <CodeBlockContent wrap>{item.reason.failure}</CodeBlockContent>
    </CodeBlock>
  );
}

/** The Sources pattern: one line that opens to a link for each artifact. */
export function ArtifactTrace({ artifacts }: { artifacts: readonly Artifact[] }) {
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

export function ArtifactLinks({ artifacts }: { artifacts: readonly Artifact[] }) {
  if (artifacts.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {artifacts.map((artifact) => (
        <Badge
          key={artifact.label}
          variant="outline"
          render={<a href={artifact.url} target="_blank" rel="noreferrer" />}
        >
          <AppIcon app={artifact.app} />
          {artifact.label}
        </Badge>
      ))}
    </span>
  );
}

export function ItemLink({ itemRef }: { itemRef: string }) {
  const open = usePrototypeAttention((state) => state.open);
  return (
    <Button size="xs" variant="link" className="px-0" onClick={() => open(itemRef)}>
      <RefLabel itemRef={itemRef} />
    </Button>
  );
}

export function DismissButton({ notification }: { notification: NotificationRecord }) {
  const dismiss = usePrototypeAttention((state) => state.dismiss);
  return (
    <Button size="sm" variant="ghost" onClick={() => dismiss(notification)}>
      Dismiss
    </Button>
  );
}

const urgency: Record<ParkTag, number> = {
  "awaiting-approval": 0,
  stuck: 1,
  exhausted: 1,
  "write-failed": 1,
  "no-workspace-recognized": 2,
  "missing-operation": 2,
  "hop-cap": 2,
  "ready-for-human": 3,
  "needs-info": 3,
};

export function useVisibleParked() {
  const resolved = usePrototypeAttention((state) => state.resolved);
  return parkedItems
    .filter((item) => !resolved[item.id])
    .toSorted((left, right) => urgency[left.reason.tag] - urgency[right.reason.tag]);
}

export function useVisibleNotifications() {
  const dismissed = usePrototypeAttention((state) => state.dismissed);
  return notifications.filter((notification) => !dismissed[notification.id]);
}

export const skippedFor = (workflow: WorkflowRef) =>
  skippedRecords.filter((record) => record.workflowId === workflow.id);

export const skippedCounts = (workflow: WorkflowRef) => {
  const records = skippedFor(workflow);
  const steps = records.filter((record) => record.kind === "step").length;
  return {
    steps,
    events: records.length - steps,
    latest: Math.max(...records.map((record) => record.atMillis)),
  };
};

export const skippedSummary = (workflow: WorkflowRef) => {
  const { steps, events } = skippedCounts(workflow);
  return [
    steps > 0 && `${steps} ${steps === 1 ? "step" : "steps"}`,
    events > 0 && `${events} ${events === 1 ? "event" : "events"}`,
  ]
    .filter(Boolean)
    .join(" · ");
};

export function SkippedLines({ workflow }: { workflow: WorkflowRef }) {
  return (
    <ul className="flex flex-col gap-2.5">
      {skippedFor(workflow).map((record) => (
        <li key={record.id} className="flex items-start gap-2">
          <AppIcon app={record.app} className="mt-0.5" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm">{record.what}</span>
            <span className="text-xs text-muted-foreground">{record.reason}</span>
          </span>
          <When atMillis={record.atMillis} />
        </li>
      ))}
    </ul>
  );
}
