import { plural } from "./format";
import type { CatalogIcon } from "./workflow-catalog";

export interface AnswerChoice {
  readonly id: string;
  readonly label: string;
  readonly input: { readonly id: string; readonly label: string } | null;
}

export type ParkReason =
  | { readonly tag: "awaiting-approval"; readonly builtOn: string }
  | { readonly tag: "handed-to-you"; readonly question: string; readonly choices: readonly AnswerChoice[] }
  | { readonly tag: "stuck"; readonly summary: string }
  | { readonly tag: "exhausted"; readonly failure: string; readonly attempts: number }
  | { readonly tag: "write-failed"; readonly step: string; readonly error: string }
  | { readonly tag: "hop-cap"; readonly hops: number }
  | { readonly tag: "missing-operation"; readonly operation: string }
  | { readonly tag: "no-workspace-recognized" };

export type ParkTag = ParkReason["tag"];

export type ParkCommand = "approve" | "reject" | "hand-back" | "choose-answer";

export type StepState = "planned" | "done" | "failed" | "skipped";

export interface AgentInputText {
  readonly id: string;
  readonly label: string;
  readonly text: string;
}

export interface PlanStep {
  readonly id: string;
  readonly app: CatalogIcon;
  readonly action: string;
  readonly target: string;
  readonly parameters: readonly string[];
  readonly inputs: readonly AgentInputText[];
  readonly state: StepState;
  readonly note: string | null;
}

export interface SourceRef {
  readonly app: CatalogIcon;
  readonly label: string;
}

export interface LineageHop {
  readonly app: CatalogIcon;
  readonly label: string;
  readonly workflow: string | null;
}

export interface Answer {
  readonly question: string;
  readonly choice: string;
}

export interface WorkflowRef {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
}

export interface ParkedItem {
  readonly id: string;
  readonly title: string;
  readonly source: SourceRef;
  readonly workflow: WorkflowRef;
  readonly operation: string;
  readonly lineage: readonly LineageHop[];
  readonly summary: string;
  readonly changedSinceParked: boolean;
  readonly parkedAtMillis: number;
  readonly reason: ParkReason;
  readonly plan: readonly PlanStep[];
  readonly commands: readonly ParkCommand[];
}

export interface Artifact {
  readonly app: CatalogIcon;
  readonly label: string;
  readonly url: string;
}

export interface NotificationRecord {
  readonly id: string;
  readonly title: string;
  readonly source: SourceRef;
  readonly workflow: WorkflowRef;
  readonly operation: string;
  readonly summary: string;
  readonly answers: readonly Answer[];
  readonly artifacts: readonly Artifact[];
  readonly atMillis: number;
}

export interface SkippedRecord {
  readonly id: string;
  readonly workflow: WorkflowRef;
  readonly kind: "step" | "event";
  readonly app: CatalogIcon;
  readonly what: string;
  readonly reason: string;
  readonly atMillis: number;
}

export type PlanEdits = Readonly<Record<string, string>>;

type ReasonOf<Tag extends ParkTag> = Extract<ParkReason, { readonly tag: Tag }>;

interface ReasonSpec<Tag extends ParkTag> {
  readonly label: string;
  readonly urgency: number;
  readonly commands: readonly ParkCommand[];
  readonly detail: (reason: ReasonOf<Tag>, item: ParkedItem) => string | null;
}

const reasonSpecs: { readonly [Tag in ParkTag]: ReasonSpec<Tag> } = {
  "awaiting-approval": {
    label: "Approval",
    urgency: 0,
    commands: ["approve", "reject", "hand-back"],
    detail: () => null,
  },
  "handed-to-you": {
    label: "Handed to you",
    urgency: 0,
    commands: ["choose-answer"],
    detail: (reason) => reason.question,
  },
  stuck: { label: "Stuck", urgency: 1, commands: ["hand-back"], detail: (reason) => reason.summary },
  exhausted: {
    label: "Failed",
    urgency: 1,
    commands: ["hand-back"],
    detail: (reason) => `${reason.failure} · ${plural(reason.attempts, "attempt")}`,
  },
  "write-failed": {
    label: "Write failed",
    urgency: 1,
    commands: ["hand-back"],
    detail: (reason) => `${reason.step}: ${reason.error}`,
  },
  "hop-cap": {
    label: "Hop cap",
    urgency: 2,
    commands: ["hand-back"],
    detail: (reason, item) => `${plural(reason.hops, "hop")} from ${item.lineage[0]?.label ?? "the root"}`,
  },
  "missing-operation": {
    label: "Missing Operation",
    urgency: 2,
    commands: ["hand-back"],
    detail: (reason, item) => `r${item.workflow.revision} has no “${reason.operation}”`,
  },
  "no-workspace-recognized": {
    label: "No Workspace",
    urgency: 2,
    commands: ["hand-back"],
    detail: () => null,
  },
};

export const commandsFor = (reason: ParkReason) => reasonSpecs[reason.tag].commands;

export const reasonLabel = (item: ParkedItem) => reasonSpecs[item.reason.tag].label;

export const byUrgency = (items: readonly ParkedItem[]) =>
  items.toSorted(
    (left, right) => reasonSpecs[left.reason.tag].urgency - reasonSpecs[right.reason.tag].urgency,
  );

const detailOf = <Tag extends ParkTag>(reason: { readonly tag: Tag } & ReasonOf<Tag>, item: ParkedItem) =>
  reasonSpecs[reason.tag].detail(reason, item);

export const cardDescription = (item: ParkedItem) => detailOf(item.reason, item) ?? item.summary;

export const workflowLabel = (workflow: WorkflowRef, operation: string) =>
  `${workflow.name} r${workflow.revision} · ${operation}`;

const pastTenses: Record<string, string> = {
  Add: "Added",
  Close: "Closed",
  Comment: "Commented",
  Create: "Created",
  Notify: "Notified",
  Open: "Opened",
  Remove: "Removed",
  Reply: "Replied",
  Request: "Requested",
  Send: "Sent",
};

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

const pastTense = (action: string) => {
  const [verb = "", ...rest] = action.split(" ");
  return [pastTenses[verb] ?? verb, ...rest].join(" ");
};

const stepTitles: Record<StepState, (action: string) => string> = {
  planned: (action) => action,
  skipped: (action) => action,
  done: pastTense,
  failed: (action) => `Failed to ${lowerFirst(action)}`,
};

export const stepTitle = (step: PlanStep) => stepTitles[step.state](step.action);

export const editKey = (item: ParkedItem, step: PlanStep, input: AgentInputText) =>
  `${item.id}/${step.id}/${input.id}`;

export const inputText = (edits: PlanEdits, item: ParkedItem, step: PlanStep, input: AgentInputText) =>
  edits[editKey(item, step, input)] ?? input.text;

export const isRunnable = (step: PlanStep) => step.state !== "skipped";

export const runnableSteps = (item: ParkedItem) => item.plan.filter(isRunnable);

export const isEdited = (item: ParkedItem, edits: PlanEdits) =>
  runnableSteps(item).some((step) =>
    step.inputs.some((input) => inputText(edits, item, step, input) !== input.text),
  );

const fnv1a = (text: string) =>
  [...text]
    .reduce((hash, char) => Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619) >>> 0, 2166136261)
    .toString(16)
    .padStart(8, "0")
    .slice(0, 7);

/** Stands in for the engine's plan digest until the read model carries it. */
export const planDigest = (item: ParkedItem, edits: PlanEdits) =>
  fnv1a(
    runnableSteps(item)
      .map(
        (step) =>
          `${step.app}:${step.action}:${step.target}:${step.parameters.join(",")}:${step.inputs
            .map((input) => inputText(edits, item, step, input))
            .join("|")}`,
      )
      .join("\n"),
  );

export const skippedByWorkflow = (records: readonly SkippedRecord[]) =>
  [...Map.groupBy(records, (record) => record.workflow.id).values()].flatMap(([first, ...rest]) =>
    first ? [{ workflow: first.workflow, records: [first, ...rest] }] : [],
  );

export const skippedSummary = (records: readonly SkippedRecord[]) => {
  const steps = records.filter((record) => record.kind === "step").length;
  const events = records.length - steps;
  return [steps > 0 && plural(steps, "step"), events > 0 && plural(events, "event")]
    .filter(Boolean)
    .join(" · ");
};
