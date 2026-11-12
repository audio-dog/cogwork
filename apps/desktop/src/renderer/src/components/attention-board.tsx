import type { WorkItemRef } from "@cogwork/contracts";
import { Alert, AlertAction, AlertDescription } from "@cogwork/ui/components/alert";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import { CodeBlock, CodeBlockContent } from "@cogwork/ui/components/code-block";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import { Field, FieldGroup } from "@cogwork/ui/components/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@cogwork/ui/components/item";
import { Separator } from "@cogwork/ui/components/separator";
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
  RiRefreshLine,
  RiShieldCheckLine,
  RiSignpostLine,
  RiSkipForwardLine,
  RiUserLine,
} from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import { type ComponentType, createContext, type ReactNode, use, useState } from "react";
import { plural, relativeTime } from "../features/format";
import { safeHref } from "../features/safe-href";
import { useNow } from "../features/use-now";
import type { CatalogIcon } from "../features/workflow-catalog";
import {
  type Answer,
  type AnswerChoice,
  type Artifact,
  byUrgency,
  cardDescription,
  editKey,
  inputText,
  isRunnable,
  type NotificationRecord,
  type ParkCommand,
  type ParkedItem,
  type ParkReason,
  type ParkTag,
  type PlanEdits,
  type PlanStep,
  reasonLabel,
  runnableSteps,
  type SkippedRecord,
  type SourceRef,
  type StepState,
  skippedByWorkflow,
  skippedSummary,
  stepTitle,
  type WorkflowRef,
  workflowLabel,
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
  readonly note: string;
}

export interface HandBack {
  readonly item: ParkedItem;
  readonly note: string;
}

export interface AnswerChosen {
  readonly item: ParkedItem;
  readonly choice: AnswerChoice;
  readonly inputs: Readonly<Record<string, string>>;
}

export interface AttentionState {
  readonly parked: readonly ParkedItem[];
  readonly notifications: readonly NotificationRecord[];
  readonly skipped: readonly SkippedRecord[];
  readonly layout: AttentionLayout;
  readonly focus: string | null;
  readonly failure: string | null;
  readonly notificationFailure: string | null;
}

export interface AttentionActions {
  readonly approve: (approval: Approval) => Promise<boolean>;
  readonly reject: (rejection: Rejection) => Promise<boolean>;
  readonly handBack: (handBack: HandBack) => Promise<boolean>;
  readonly chooseAnswer: (answer: AnswerChosen) => Promise<boolean>;
  readonly dismiss: (notification: NotificationRecord) => Promise<boolean>;
  readonly openItem: (item: WorkItemRef) => void;
  readonly setFocus: (id: string | null) => void;
  readonly setLayout: (layout: AttentionLayout) => void;
  readonly openNotificationSettings: () => void;
}

export type AttentionMeta = Record<string, never>;

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

type ResponseMode = "view" | "edit" | "reject" | "hand-back";

interface ParkDraft {
  readonly mode: ResponseMode;
  readonly edits: PlanEdits;
  readonly note: string;
  readonly choice: string | null;
  readonly inputs: Readonly<Record<string, string>>;
}

const emptyDraft: ParkDraft = { mode: "view", edits: {}, note: "", choice: null, inputs: {} };

interface DraftsContextValue {
  state: { drafts: Readonly<Record<string, ParkDraft>> };
  actions: {
    update: (id: string, change: Partial<ParkDraft>) => void;
    discard: (id: string) => void;
  };
  meta: Record<string, never>;
}

const DraftsContext = createContext<DraftsContextValue | null>(null);

function useDrafts() {
  const value = use(DraftsContext);
  if (!value) throw new Error("Draft parts must render inside Attention.Provider");
  return value;
}

function AttentionProvider({ children, ...value }: AttentionContextValue & { children: ReactNode }) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, ParkDraft>>>({});
  const discard = (id: string) => setDrafts(({ [id]: _discarded, ...rest }) => rest);
  return (
    <AttentionContext value={value}>
      <DraftsContext
        value={{
          state: { drafts },
          actions: {
            update: (id, change) =>
              setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? emptyDraft), ...change } })),
            discard,
          },
          meta: {},
        }}
      >
        {children}
      </DraftsContext>
    </AttentionContext>
  );
}

const scrollIntoView = (node: HTMLElement | null) => node?.scrollIntoView({ block: "nearest" });

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

function CatalogGlyph({ app }: { app: CatalogIcon }) {
  const Icon = catalogIconFor(app);
  return <Icon />;
}

function AppIcon({ app }: { app: CatalogIcon }) {
  const Icon = catalogIconFor(app);
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" />;
}

function RelativeTime({ atMillis }: { atMillis: number }) {
  const now = useNow(60_000);
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{relativeTime(atMillis, now)}</span>
  );
}

const trackerApps: ReadonlySet<CatalogIcon> = new Set(["github", "linear"]);

function SourceLabel({ source }: { source: SourceRef }) {
  return <span className={cn("truncate", trackerApps.has(source.app) && "font-mono")}>{source.label}</span>;
}

function ItemLink({ item, source }: { item: WorkItemRef; source: SourceRef }) {
  const {
    actions: { openItem },
  } = useAttention();
  return (
    <Button size="xs" variant="link" className="px-0" onClick={() => openItem(item)}>
      <SourceLabel source={source} />
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

function AnswerChips({ answers }: { answers: readonly Answer[] }) {
  if (answers.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {answers.map((answer) => (
        <Badge key={answer.question} variant="secondary">
          <span className="font-mono">
            {answer.question}: {answer.choice}
          </span>
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
    <CollapsibleTrigger
      nativeButton={false}
      render={<CardHeader />}
      className="w-full py-3 text-start outline-none focus-visible:bg-muted/50"
    >
      {children}
    </CollapsibleTrigger>
  );
}

function AttentionCardTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <CardTitle className="flex items-start gap-2.5">
      <span className="flex h-5 items-center">{icon}</span>
      {children}
    </CardTitle>
  );
}

function AttentionCardDescription({ children }: { children: ReactNode }) {
  return <CardDescription className="line-clamp-2 ps-6.5">{children}</CardDescription>;
}

function AttentionCardMeta({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 ps-6.5 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

function AttentionCardDetail({ children }: { children: ReactNode }) {
  return (
    <CollapsibleContent>
      <CardContent className="flex flex-col gap-3 pb-3">
        <Separator />
        {children}
      </CardContent>
    </CollapsibleContent>
  );
}

const AttentionCard = {
  Root: AttentionCardRoot,
  Summary: AttentionCardSummary,
  Title: AttentionCardTitle,
  Description: AttentionCardDescription,
  Meta: AttentionCardMeta,
  Detail: AttentionCardDetail,
};

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

function ParkedCard({ item }: { item: ParkedItem }) {
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
        <ParkedProvider item={item}>
          <ParkedPlan />
          <ParkedCommands />
        </ParkedProvider>
      </AttentionCard.Detail>
    </AttentionCard.Root>
  );
}

function ArtifactLine({ artifact }: { artifact: Artifact }) {
  return (
    <TraceLine>
      <TraceIcon>
        <CatalogGlyph app={artifact.app} />
      </TraceIcon>
      <TraceTitle>
        {artifact.label}
        <span className="sr-only"> (opens in a new tab)</span>
      </TraceTitle>
      <TraceIcon>
        <RiArrowRightUpLine />
      </TraceIcon>
    </TraceLine>
  );
}

function ArtifactTrace({ artifacts }: { artifacts: readonly Artifact[] }) {
  if (artifacts.length === 0) return null;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceTitle>{`Created ${plural(artifacts.length, "artifact")}`}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Trace>
          {artifacts.map((artifact) => {
            const href = safeHref(artifact.url);
            if (!href) return <ArtifactLine key={artifact.label} artifact={artifact} />;
            return (
              <a key={artifact.label} href={href} target="_blank" rel="noreferrer">
                <ArtifactLine artifact={artifact} />
              </a>
            );
          })}
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
        <AttentionCard.Title icon={<RiBellLine className="size-4 shrink-0 text-muted-foreground" />}>
          {notification.title}
        </AttentionCard.Title>
        <AttentionCard.Description>{notification.summary}</AttentionCard.Description>
        <AttentionCard.Meta>
          <RelativeTime atMillis={notification.atMillis} />
          <span className="ms-auto" />
          <AppIcon app={notification.source.app} />
          <SourceLabel source={notification.source} />
        </AttentionCard.Meta>
      </AttentionCard.Summary>
      <AttentionCard.Detail>
        <span className="text-xs text-muted-foreground">
          {workflowLabel(notification.workflow, notification.operation)}
        </span>
        <AnswerChips answers={notification.answers} />
        <ArtifactTrace artifacts={notification.artifacts} />
        <span className="flex items-center justify-between">
          <ItemLink item={notification.item} source={notification.source} />
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
        <AttentionCard.Title icon={<RiSkipForwardLine className="size-4 shrink-0 text-muted-foreground" />}>
          {workflow.name}
        </AttentionCard.Title>
        <AttentionCard.Description>{records[0]?.reason}</AttentionCard.Description>
        <AttentionCard.Meta>
          <span className="text-foreground">{skippedSummary(records)}</span>
          <span aria-hidden>·</span>
          <RelativeTime atMillis={latest} />
        </AttentionCard.Meta>
      </AttentionCard.Summary>
      <AttentionCard.Detail>
        <ItemGroup className="gap-1">
          {records.map((record) => (
            <Item key={record.id} size="xs">
              <ItemMedia variant="icon">
                <CatalogGlyph app={record.app} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{record.what}</ItemTitle>
                <ItemDescription>{record.reason}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <RelativeTime atMillis={record.atMillis} />
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
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
    state: { layout, failure, notificationFailure },
    actions: { setLayout, openNotificationSettings },
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
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {notificationFailure && (
        <Alert variant="destructive">
          <AlertDescription>
            {notificationFailure}. Parks still appear here. Allow Cogwork notifications in System Settings.
          </AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={openNotificationSettings}>
              System Settings
            </Button>
          </AlertAction>
        </Alert>
      )}
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
