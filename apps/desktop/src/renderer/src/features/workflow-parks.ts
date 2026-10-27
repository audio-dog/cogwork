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

/** Agent-input text a person edited before approving, keyed by `editKey`. */
export type PlanEdits = Readonly<Record<string, string>>;

export const commandsFor = (reason: ParkReason): readonly ParkCommand[] => {
  if (reason.tag === "awaiting-approval") return ["approve", "reject", "hand-back"];
  if (reason.tag === "needs-info" || reason.tag === "ready-for-human") return ["open"];
  return ["hand-back"];
};

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

export const reasonDetail = (item: ParkedItem) => {
  const { reason } = item;
  if (reason.tag === "stuck") return reason.summary;
  if (reason.tag === "exhausted") return `${reason.failure} · ${reason.attempts} attempts`;
  if (reason.tag === "write-failed") return `${reason.step}: ${reason.error}`;
  if (reason.tag === "hop-cap") return `${reason.hops} hops from ${item.lineage[0]?.label ?? "the root"}`;
  if (reason.tag === "missing-operation") return `r${item.workflow.revision} has no “${reason.operation}”`;
  return null;
};

/** What a card shows under its title: the reason when it has text, else the element summary. */
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

/** A step title says what happened: "Create an issue", "Created an issue", "Failed to add a label". */
export const stepTitle = (step: PlanStep) => {
  const [verb = "", ...rest] = step.action.split(" ");
  if (step.state === "failed") return `Failed to ${lowerFirst(step.action)}`;
  if (step.state === "done") return [pastTenses[verb] ?? verb, ...rest].join(" ");
  return step.action;
};

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

/**
 * Stands in for the engine's plan digest until the read model carries it. An approval names the
 * digest of what the person saw, so any edit to agent-input text must change it.
 */
export const planDigest = (item: ParkedItem, edits: PlanEdits) =>
  fnv1a(
    item.plan
      .filter((step) => step.state !== "skipped")
      .map(
        (step) =>
          `${step.app}:${step.action}:${step.target}:${step.parameters.join(",")}:${step.inputs
            .map((input) => inputText(edits, item, step, input))
            .join("|")}`,
      )
      .join("\n"),
  );

export const skippedByWorkflow = (records: readonly SkippedRecord[]) =>
  records
    .filter(
      (record, index) => records.findIndex((first) => first.workflow.id === record.workflow.id) === index,
    )
    .map(({ workflow }) => ({
      workflow,
      records: records.filter((record) => record.workflow.id === workflow.id),
    }));

export const skippedSummary = (records: readonly SkippedRecord[]) => {
  const steps = records.filter((record) => record.kind === "step").length;
  const events = records.length - steps;
  return [
    steps > 0 && `${steps} ${steps === 1 ? "step" : "steps"}`,
    events > 0 && `${events} ${events === 1 ? "event" : "events"}`,
  ]
    .filter(Boolean)
    .join(" · ");
};
