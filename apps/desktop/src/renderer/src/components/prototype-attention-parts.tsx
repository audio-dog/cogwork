import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Textarea } from "@cogwork/ui/components/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import {
  RiArrowRightSLine,
  RiBellLine,
  RiCheckLine,
  RiCloseCircleLine,
  RiErrorWarningLine,
  RiLoopLeftLine,
  RiMapPinLine,
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
  type SkippedRecord,
  skippedRecords,
  type WorkflowRef,
} from "../features/prototype-attention-data";
import { type ResponseMode, usePrototypeAttention } from "../features/prototype-attention-store";
import { catalogIconFor } from "./workflow-catalog-menu";

/** PROTOTYPE — issue #794. Parts the attention variants share. */

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

const fixedReasonTitles = {
  "awaiting-approval": "Waits for approval",
  stuck: "Stuck",
  "no-workspace-recognized": "No Workspace recognized",
  "needs-info": "Needs info",
  "ready-for-human": "Ready for a person",
};

export const reasonTitle = (item: ParkedItem) => {
  const { reason } = item;
  if (reason.tag === "exhausted") return `Failed ${reason.attempts} times`;
  if (reason.tag === "write-failed") return `Write failed: ${reason.step}`;
  if (reason.tag === "hop-cap") return `Hop cap: ${reason.hops} hops`;
  if (reason.tag === "missing-operation") return `r${item.workflow.revision} has no “${reason.operation}”`;
  return fixedReasonTitles[reason.tag];
};

export const reasonDetail = (reason: ParkReason) => {
  if (reason.tag === "stuck") return reason.summary;
  if (reason.tag === "exhausted") return reason.failure;
  if (reason.tag === "write-failed") return reason.error;
  return null;
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

export function WorkflowTag({ workflow, operation }: { workflow: WorkflowRef; operation?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="truncate">{workflow.name}</span>
      <span className="font-mono text-[10px]">r{workflow.revision}</span>
      {operation && (
        <>
          <span aria-hidden>·</span>
          <span className="truncate text-foreground/80">{operation}</span>
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

export function ChangedBadge() {
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="outline" />}>
        <RiRefreshLine data-icon="inline-start" />
        Changed
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

/** Root first, the item's own Operation last. */
export function LineageTrail({ item }: { item: ParkedItem }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-muted-foreground">
      {item.lineage.map((hop, index) => (
        <span key={`${hop.label}:${index}`} className="flex items-center gap-1">
          <HopLabel hop={hop} />
          <RiArrowRightSLine className="size-3.5 shrink-0" />
        </span>
      ))}
      <span className="flex items-center gap-1 font-medium text-foreground">
        <AppIcon app="operation" className="text-foreground" />
        {item.operation}
      </span>
    </span>
  );
}

interface WorkflowRun {
  readonly workflow: string | null;
  readonly hops: readonly LineageHop[];
}

/** A source belongs to the Workflow it started; an artifact to the Workflow that created it. */
const hopWorkflow = (hops: readonly LineageHop[], index: number) => {
  const hop = hops[index];
  if (hop?.kind === "operation") return hop.workflow;
  if (hop?.kind === "artifact") {
    return hops.slice(0, index).findLast((earlier) => earlier.kind === "operation")?.workflow ?? null;
  }
  return hops.slice(index).find((later) => later.kind === "operation")?.workflow ?? null;
};

const workflowRuns = (item: ParkedItem) => {
  const current: LineageHop = {
    kind: "operation",
    app: "operation",
    label: item.operation,
    workflow: item.workflow.name,
  };
  const hops = [...item.lineage, current];
  const hopWorkflows = hops.map((_, index) => hopWorkflow(hops, index));
  const starts = hopWorkflows.flatMap((workflow, index) =>
    index === 0 || workflow !== hopWorkflows[index - 1] ? [index] : [],
  );
  return starts.map(
    (start, runIndex): WorkflowRun => ({
      workflow: hopWorkflows[start] ?? null,
      hops: hops.slice(start, starts[runIndex + 1]),
    }),
  );
};

/** Groups the hops by the Workflow that ran them, so each hand-off between Workflows shows. */
export function LineageTimeline({ item }: { item: ParkedItem }) {
  const runs = workflowRuns(item);
  const isCurrent = (runIndex: number, hopIndex: number, run: WorkflowRun) =>
    runIndex === runs.length - 1 && hopIndex === run.hops.length - 1;
  return (
    <ol className="flex flex-col gap-3">
      {runs.map((run, runIndex) => (
        <li key={`${run.workflow}:${runIndex}`} className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">{run.workflow}</span>
          <ol className="flex flex-col gap-1 border-s ps-3">
            {run.hops.map((hop, index) => (
              <li
                key={`${hop.label}:${index}`}
                className={cn(
                  "text-xs",
                  isCurrent(runIndex, index, run) && "font-medium text-foreground",
                  !isCurrent(runIndex, index, run) && "text-muted-foreground",
                )}
              >
                <HopLabel hop={hop} />
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}

function StepState({ step }: { step: PlanStep }) {
  if (step.state === "done") return <RiCheckLine className="size-4 shrink-0 text-success" />;
  if (step.state === "failed") return <RiCloseCircleLine className="size-4 shrink-0 text-destructive" />;
  if (step.state === "skipped")
    return <RiSkipForwardLine className="size-4 shrink-0 text-muted-foreground" />;
  return <span className="size-4 shrink-0" aria-hidden />;
}

function StepHeader({ step, index }: { step: PlanStep; index: number }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="w-4 shrink-0 text-end font-mono text-xs text-muted-foreground">{index + 1}</span>
      <AppIcon app={step.app} className="text-foreground" />
      <span
        className={cn("truncate text-sm", step.state === "skipped" && "text-muted-foreground line-through")}
      >
        {step.action}
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground">{step.target}</span>
      {step.parameters.map((parameter) => (
        <Badge key={parameter} variant="outline" className="font-normal">
          {parameter}
        </Badge>
      ))}
      <span className="ms-auto" />
      <StepState step={step} />
    </span>
  );
}

function StepNote({ step }: { step: PlanStep }) {
  if (!step.note) return null;
  return (
    <span
      className={cn(
        "ps-6 text-xs",
        step.state === "failed" && "text-destructive",
        step.state !== "failed" && "text-muted-foreground",
      )}
    >
      {step.note}
    </span>
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

function ParkedPlan() {
  const {
    state: { item, mode },
    actions: { setEdit },
    meta: { edits },
  } = useParked();
  if (item.plan.length === 0) return null;
  return (
    <ol className="flex flex-col gap-3">
      {item.plan.map((step, index) => (
        <li key={step.id} className="flex flex-col gap-1">
          <StepHeader step={step} index={index} />
          <StepNote step={step} />
          {step.inputs.map((agentInput) => (
            <div key={agentInput.id} className="flex flex-col gap-0.5 ps-6">
              <span className="text-[11px] text-muted-foreground">{agentInput.label}</span>
              {mode === "edit" ? (
                <Textarea
                  aria-label={agentInput.label}
                  value={inputText(edits, item, step, agentInput)}
                  onChange={(event) => setEdit(editKey(item, step, agentInput), event.target.value)}
                />
              ) : (
                <p className="text-sm whitespace-pre-wrap">{inputText(edits, item, step, agentInput)}</p>
              )}
            </div>
          ))}
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
      <TooltipTrigger render={<Badge variant={edited ? "default" : "outline"} className="font-mono" />}>
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
      <div className="flex items-center justify-end gap-2">
        <ParkedDigest />
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
    <div className="flex items-center justify-end gap-2">
      <ParkedDigest />
      <span className="me-auto" />
      <Button size="sm" variant="ghost" onClick={() => setMode("hand-back")}>
        Hand back
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setMode("reject")}>
        Reject
      </Button>
      <Button size="sm" variant="outline" onClick={() => setMode("edit")}>
        Edit
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
    <div className="flex items-center justify-end gap-2">
      {item.reason.tag === "missing-operation" && (
        <Button
          size="sm"
          variant="outline"
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

export const Parked = {
  Provider: ParkedProvider,
  Plan: ParkedPlan,
  Commands: ParkedCommands,
};

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
    <Button size="xs" variant="link" className="px-0 font-mono" onClick={() => open(itemRef)}>
      {itemRef}
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

export function SkippedRow({ record }: { record: SkippedRecord }) {
  return (
    <div className="flex items-center gap-2 py-1.5 text-sm">
      <AppIcon app={record.app} />
      <Badge variant="outline" className="w-12 justify-center font-normal">
        {record.kind}
      </Badge>
      <span className="min-w-0 truncate">{record.what}</span>
      <span className="min-w-0 flex-1 truncate text-end text-xs text-muted-foreground">{record.reason}</span>
      <When atMillis={record.atMillis} />
    </div>
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

interface FocusContextValue {
  focus: string | null;
  setFocus: (id: string | null) => void;
}

const FocusContext = createContext<FocusContextValue | null>(null);

export function FocusProvider({ children, ...value }: FocusContextValue & { children: ReactNode }) {
  return <FocusContext value={value}>{children}</FocusContext>;
}

export function useFocus() {
  const value = use(FocusContext);
  if (!value) throw new Error("useFocus must render inside FocusProvider");
  return value;
}

export const scrollIntoView = (node: HTMLElement | null) => node?.scrollIntoView({ block: "nearest" });
