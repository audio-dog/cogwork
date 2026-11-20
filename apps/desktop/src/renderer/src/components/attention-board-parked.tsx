import { Button } from "@cogwork/ui/components/button";
import { CodeBlock, CodeBlockContent } from "@cogwork/ui/components/code-block";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import { Field, FieldGroup } from "@cogwork/ui/components/field";
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
  RiCloseCircleLine,
  RiErrorWarningLine,
  RiGitBranchLine,
  RiLoopLeftLine,
  RiMapPinLine,
  RiMoreLine,
  RiRefreshLine,
  RiShieldCheckLine,
  RiSignpostLine,
  RiSkipForwardLine,
  RiStopCircleLine,
  RiUserLine,
} from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import { type ComponentType, createContext, type ReactNode, use } from "react";

import { plural } from "../features/format";
import {
  type AnswerChoice,
  cardDescription,
  editKey,
  inputText,
  isRunnable,
  type ParkCommand,
  type ParkedItem,
  type ParkReason,
  type ParkTag,
  type PlanStep,
  reasonLabel,
  runnableSteps,
  type StepState,
  stepTitle,
  workflowLabel,
  worktreeBlockedLines,
} from "../features/workflow-parks";
import { AppIcon, AttentionCard, CatalogGlyph, RelativeTime, SourceLabel } from "./attention-board-card";
import {
  emptyDraft,
  type ParkDraft,
  type ResponseMode,
  useAttention,
  useDrafts,
} from "./attention-board-context";

type ReasonTone = "decision" | "failure" | "setup";

const reasonPresentations: Record<
  ParkTag,
  { icon: ComponentType<{ className?: string }>; tone: ReasonTone }
> = {
  "awaiting-approval": { icon: RiShieldCheckLine, tone: "decision" },
  "handed-to-you": { icon: RiUserLine, tone: "decision" },
  stuck: { icon: RiErrorWarningLine, tone: "failure" },
  exhausted: { icon: RiCloseCircleLine, tone: "failure" },
  "write-failed": { icon: RiCloseCircleLine, tone: "failure" },
  "hop-cap": { icon: RiLoopLeftLine, tone: "setup" },
  "missing-operation": { icon: RiSignpostLine, tone: "setup" },
  "plan-rejected": { icon: RiCloseCircleLine, tone: "failure" },
  "draft-outcome-unknown": { icon: RiErrorWarningLine, tone: "failure" },
  "no-workspace-recognized": { icon: RiMapPinLine, tone: "setup" },
  "worktree-blocked": { icon: RiGitBranchLine, tone: "failure" },
  cancelled: { icon: RiStopCircleLine, tone: "decision" },
};

function ReasonIcon({ reason }: { reason: ParkReason }) {
  const { icon: Icon, tone } = reasonPresentations[reason.tag];
  return (
    <Icon
      className={cn(
        "size-4 shrink-0",
        tone === "decision" && "text-primary",
        tone === "failure" && "text-destructive",
        tone === "setup" && "text-warning",
      )}
    />
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

interface ParkedContextValue {
  state: { item: ParkedItem; draft: ParkDraft; digest: string };
  actions: {
    update: (change: Partial<ParkDraft>) => void;
    cancel: () => void;
    setEdit: (key: string, text: string) => void;
    approve: () => void;
    reject: () => void;
    handBack: () => void;
    chooseAnswer: (choice: AnswerChoice) => void;
  };
  meta: Record<string, never>;
}

const ParkedContext = createContext<ParkedContextValue | null>(null);

function useParked() {
  const value = use(ParkedContext);
  if (!value) throw new Error("Parked parts must render inside ParkedProvider");
  return value;
}

function ParkedProvider({ item, children }: { item: ParkedItem; children: ReactNode }) {
  const { actions } = useAttention();
  const {
    state: { drafts },
    actions: { update, discard },
  } = useDrafts();
  const draft = drafts[item.id] ?? emptyDraft;
  const digest = item.reason.tag === "awaiting-approval" ? item.reason.digest : "";
  const send = async (command: () => Promise<boolean>) => {
    if (await command()) discard(item.id);
  };
  return (
    <ParkedContext
      value={{
        state: { item, draft, digest },
        actions: {
          update: (change) => update(item.id, change),
          cancel: () => discard(item.id),
          setEdit: (key, text) => update(item.id, { edits: { ...draft.edits, [key]: text } }),
          approve: () => send(() => actions.approve({ item, digest, edits: draft.edits })),
          reject: () => send(() => actions.reject({ item, note: draft.note })),
          handBack: () => send(() => actions.handBack({ item, note: draft.note })),
          chooseAnswer: (choice) => send(() => actions.chooseAnswer({ item, choice, inputs: draft.inputs })),
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
    state: { draft },
    actions: { setEdit },
  } = useParked();
  const editable = draft.mode === "edit" && isRunnable(step);
  return (
    <FieldGroup>
      {step.inputs.map((input, index) => {
        const isLead = index === 0;
        return editable ? (
          <Field key={input.id}>
            <Textarea
              aria-label={input.label}
              value={inputText(draft.edits, input)}
              onChange={(event) => setEdit(editKey(input), event.target.value)}
            />
          </Field>
        ) : (
          <p
            key={input.id}
            className={cn(
              "text-sm whitespace-pre-wrap",
              isLead && "text-foreground",
              !isLead && "text-muted-foreground",
            )}
          >
            {inputText(draft.edits, input)}
          </p>
        );
      })}
    </FieldGroup>
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
        <CatalogGlyph app={step.app} />
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

function FailureText({ text }: { text: string }) {
  return (
    <CodeBlock size="sm" variant="destructive">
      <CodeBlockContent wrap>{text}</CodeBlockContent>
    </CodeBlock>
  );
}

const failureNote = (step: PlanStep) => (step.state === "failed" ? step.note : null);

function StepDetail({ step }: { step: PlanStep }) {
  const failure = failureNote(step);
  if (failure) return <FailureText text={failure} />;
  return <StepInputs step={step} />;
}

const hasStepDetail = (step: PlanStep) => step.inputs.length > 0 || failureNote(step) !== null;

function ParkedPlan() {
  const {
    state: { item, draft },
  } = useParked();
  if (item.plan.length === 0) return null;
  return (
    <Trace>
      {item.plan.map((step) =>
        hasStepDetail(step) ? (
          <TraceCollapsible
            key={`${step.id}:${draft.mode}`}
            defaultOpen={draft.mode === "edit" || step.state === "failed"}
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
    state: { draft },
    actions: { update, cancel },
  } = useParked();
  return (
    <FieldGroup>
      <Field>
        <Textarea
          aria-label="Note"
          placeholder="Note"
          value={draft.note}
          onChange={(event) => update({ note: event.target.value })}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        <Button size="sm" variant={variant} onClick={onConfirm}>
          {confirm}
        </Button>
      </div>
    </FieldGroup>
  );
}

function RejectNote() {
  const {
    actions: { reject },
  } = useParked();
  return <NoteCommand confirm="Reject" variant="destructive" onConfirm={reject} />;
}

function HandBackNote() {
  const {
    actions: { handBack },
  } = useParked();
  return <NoteCommand confirm="Hand back" variant="default" onConfirm={handBack} />;
}

function ApprovalSummary({ children }: { children: ReactNode }) {
  const {
    state: { item, digest },
  } = useParked();
  const builtOn = item.reason.tag === "awaiting-approval" ? item.reason.builtOn : null;
  return (
    <Item variant="muted" size="sm">
      <ItemContent>
        <ItemTitle>{`Run ${plural(runnableSteps(item).length, "step")}?`}</ItemTitle>
        <ItemDescription>
          <span className="font-mono">{digest}</span>
          {builtOn && ` · built on ${builtOn}`}
        </ItemDescription>
      </ItemContent>
      <ItemActions>{children}</ItemActions>
    </Item>
  );
}

function ApprovalView() {
  const {
    actions: { update, approve },
  } = useParked();
  return (
    <ApprovalSummary>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button aria-label="More" size="icon-sm" variant="ghost" />}>
          <RiMoreLine />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => update({ mode: "edit" })}>Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={() => update({ mode: "hand-back" })}>Hand back</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button size="sm" variant="outline" onClick={() => update({ mode: "reject" })}>
        Reject
      </Button>
      <Button size="sm" onClick={approve}>
        Approve
      </Button>
    </ApprovalSummary>
  );
}

function ApprovalEdit() {
  const {
    actions: { cancel, approve },
  } = useParked();
  return (
    <ApprovalSummary>
      <Button size="sm" variant="ghost" onClick={cancel}>
        Cancel
      </Button>
      <Button size="sm" onClick={approve}>
        Approve
      </Button>
    </ApprovalSummary>
  );
}

const approvalPanels: Record<ResponseMode, ComponentType> = {
  view: ApprovalView,
  edit: ApprovalEdit,
  reject: RejectNote,
  "hand-back": HandBackNote,
};

function ApprovalPrompt() {
  const {
    state: { draft },
  } = useParked();
  const Panel = approvalPanels[draft.mode];
  return <Panel />;
}

function AnswerInputs({ choice }: { choice: AnswerChoice }) {
  const {
    state: { draft },
    actions: { update, cancel, chooseAnswer },
  } = useParked();
  return (
    <FieldGroup>
      {choice.inputs.map((input) => (
        <Field key={input.id}>
          <Textarea
            aria-label={input.label}
            placeholder={input.label}
            value={draft.inputs[input.id] ?? ""}
            onChange={(event) => update({ inputs: { ...draft.inputs, [input.id]: event.target.value } })}
          />
        </Field>
      ))}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={choice.inputs.some(({ id }) => !draft.inputs[id]?.trim())}
          onClick={() => chooseAnswer(choice)}
        >
          {choice.label}
        </Button>
      </div>
    </FieldGroup>
  );
}

function AnswerPrompt() {
  const {
    state: { item, draft },
    actions: { update, chooseAnswer },
  } = useParked();
  const choices = item.reason.tag === "handed-to-you" ? item.reason.choices : [];
  const pending = choices.find((choice) => choice.id === draft.choice);
  if (pending?.inputs.length) return <AnswerInputs choice={pending} />;
  const pick = (choice: AnswerChoice) => {
    if (choice.inputs.length > 0) {
      update({ choice: choice.id });
      return;
    }
    chooseAnswer(choice);
  };
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {choices.map((choice) => (
        <Button key={choice.id} size="sm" variant="outline" onClick={() => pick(choice)}>
          {choice.label}
        </Button>
      ))}
    </div>
  );
}

function HandBackCommands() {
  const {
    state: { item, draft },
    actions: { update },
  } = useParked();
  if (draft.mode === "hand-back") return <HandBackNote />;
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
      <Button size="sm" onClick={() => update({ mode: "hand-back" })}>
        Hand back
      </Button>
    </div>
  );
}

function AnswerCommands() {
  return (
    <div className="flex flex-col gap-2">
      <AnswerPrompt />
      <HandBackCommands />
    </div>
  );
}

const commandPanels: ReadonlyArray<{ command: ParkCommand; Panel: ComponentType }> = [
  { command: "approve", Panel: ApprovalPrompt },
  { command: "choose-answer", Panel: AnswerCommands },
  { command: "hand-back", Panel: HandBackCommands },
];

function ParkedCommands() {
  const {
    state: { item },
  } = useParked();
  const entry = commandPanels.find(({ command }) => item.commands.includes(command));
  if (!entry) return null;
  return <entry.Panel />;
}

function LineageTrace({ item }: { item: ParkedItem }) {
  const [root] = item.lineage;
  if (!root) return null;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon>
            <CatalogGlyph app={root.app} />
          </TraceIcon>
          <TraceTitle>From {root.label}</TraceTitle>
          <TraceDescription>{workflowLabel(item.workflow, item.operation)}</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Trace>
          {item.lineage.map((hop, index) => (
            <TraceLine key={`${hop.label}:${index}`}>
              <TraceIcon>
                <CatalogGlyph app={hop.app} />
              </TraceIcon>
              <TraceTitle>{hop.label}</TraceTitle>
              {hop.workflow && <TraceDescription>{hop.workflow}</TraceDescription>}
            </TraceLine>
          ))}
          <TraceLine>
            <TraceIcon>
              <CatalogGlyph app="operation" />
            </TraceIcon>
            <TraceTitle>{item.operation}</TraceTitle>
            <TraceDescription>{item.workflow.name}</TraceDescription>
          </TraceLine>
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function ExhaustedFailure({ item }: { item: ParkedItem }) {
  if (item.reason.tag !== "exhausted") return null;
  return <FailureText text={item.reason.failure} />;
}

function WorktreeBlockedLocation({ item }: { item: ParkedItem }) {
  const lines = item.reason.tag === "worktree-blocked" ? worktreeBlockedLines(item.reason) : [];
  if (lines.length === 0) return null;
  return (
    <CodeBlock size="sm">
      <CodeBlockContent wrap>{lines.join("\n")}</CodeBlockContent>
    </CodeBlock>
  );
}

export function ParkedCard({ item }: { item: ParkedItem }) {
  const description = cardDescription(item);
  return (
    <AttentionCard.Root id={item.id}>
      <AttentionCard.Summary>
        <AttentionCard.Title icon={<ReasonIcon reason={item.reason} />}>{item.title}</AttentionCard.Title>
        <AttentionCard.Description>{description}</AttentionCard.Description>
        <AttentionCard.Meta>
          <span className="text-foreground">{reasonLabel(item)}</span>
          <span aria-hidden>·</span>
          <RelativeTime atMillis={item.parkedAtMillis} />
          {item.changedSinceParked && <ChangedMark />}
          <span className="ms-auto" />
          <AppIcon app={item.source.app} />
          <SourceLabel source={item.source} />
        </AttentionCard.Meta>
      </AttentionCard.Summary>
      <AttentionCard.Detail>
        <LineageTrace item={item} />
        {description !== item.summary && <p className="text-sm">{item.summary}</p>}
        <ExhaustedFailure item={item} />
        <WorktreeBlockedLocation item={item} />
        <ParkedProvider item={item}>
          <ParkedPlan />
          <ParkedCommands />
        </ParkedProvider>
      </AttentionCard.Detail>
    </AttentionCard.Root>
  );
}
