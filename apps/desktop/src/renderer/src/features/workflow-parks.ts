import type { CatalogIcon } from "./workflow-catalog";

export type ParkReason =
  | { readonly tag: "needs-info" }
  | { readonly tag: "ready-for-human" }
  | { readonly tag: "stuck"; readonly summary: string }
  | { readonly tag: "exhausted"; readonly failure: string; readonly attempts: number }
  | { readonly tag: "hop-cap"; readonly hops: number }
  | { readonly tag: "missing-operation"; readonly operation: string }
  | { readonly tag: "write-failed"; readonly step: string; readonly error: string }
  | { readonly tag: "no-workspace-recognized" }
  | { readonly tag: "awaiting-approval"; readonly builtOn: string };

export type ParkTag = ParkReason["tag"];

export type ParkCommand = "approve" | "reject" | "hand-back" | "open";

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

export interface LineageHop {
  readonly kind: "source" | "operation" | "artifact";
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
  readonly ref: string;
  readonly source: CatalogIcon;
  readonly workspace: string | null;
  readonly workflow: WorkflowRef;
  readonly operation: string;
  readonly lineage: readonly LineageHop[];
  readonly summary: string;
  readonly answers: readonly Answer[];
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
  readonly ref: string;
  readonly source: CatalogIcon;
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

const parkCommands: Record<ParkTag, readonly ParkCommand[]> = {
  "awaiting-approval": ["approve", "reject", "hand-back"],
  "needs-info": ["open"],
  "ready-for-human": ["open"],
  stuck: ["hand-back"],
  exhausted: ["hand-back"],
  "write-failed": ["hand-back"],
  "hop-cap": ["hand-back"],
  "missing-operation": ["hand-back"],
  "no-workspace-recognized": ["hand-back"],
};

export const commandsFor = (reason: ParkReason) => parkCommands[reason.tag];

export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

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

export const byUrgency = (items: readonly ParkedItem[]) =>
  items.toSorted((left, right) => urgency[left.reason.tag] - urgency[right.reason.tag]);

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

type ReasonOf<Tag extends ParkTag> = Extract<ParkReason, { readonly tag: Tag }>;

const reasonDetails: { [Tag in ParkTag]: (reason: ReasonOf<Tag>, item: ParkedItem) => string | null } = {
  stuck: (reason) => reason.summary,
  exhausted: (reason) => `${reason.failure} · ${reason.attempts} attempts`,
  "write-failed": (reason) => `${reason.step}: ${reason.error}`,
  "hop-cap": (reason, item) => `${reason.hops} hops from ${item.lineage[0]?.label ?? "the root"}`,
  "missing-operation": (reason, item) => `r${item.workflow.revision} has no “${reason.operation}”`,
  "awaiting-approval": () => null,
  "needs-info": () => null,
  "ready-for-human": () => null,
  "no-workspace-recognized": () => null,
};

const detailOf = <Tag extends ParkTag>(reason: { readonly tag: Tag } & ReasonOf<Tag>, item: ParkedItem) =>
  reasonDetails[reason.tag](reason, item);

export const reasonDetail = (item: ParkedItem) => detailOf(item.reason, item);

export const cardDescription = (item: ParkedItem) => reasonDetail(item) ?? item.summary;

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

export const isEdited = (item: ParkedItem, edits: PlanEdits) =>
  item.plan.some((step) => step.inputs.some((input) => inputText(edits, item, step, input) !== input.text));

const fnv1a = (text: string) =>
  [...text]
    .reduce((hash, char) => Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619) >>> 0, 2166136261)
    .toString(16)
    .padStart(8, "0")
    .slice(0, 7);

export const runnableSteps = (item: ParkedItem) => item.plan.filter((step) => step.state !== "skipped");

/**
 * Stands in for the engine's plan digest until the read model carries it. An approval names the
 * digest of what the person saw, so any edit to agent-input text must change it.
 */
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
