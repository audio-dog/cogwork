import { type CatalogChoice, isHandOff } from "./workflow-catalog";
import { type Condition, type Operation, stepsAt, type Workflow } from "./workflow-model";

/**
 * The Workflows list's summary of one Workflow: the chain of Operations work passes through, and
 * for each outcome the one consequence worth naming in a row.
 */

/** The Operations work passes through, found by following each Operation's first hand-off. */
export const spineOf = (workflow: Workflow): readonly Operation[] => {
  const byId = (id: string) => workflow.operations.find((operation) => operation.id === id);
  const walk = (operation: Operation, seen: readonly Operation[]): readonly Operation[] => {
    const next = operation.routes
      .flatMap((route) => route.steps.filter(isHandOff))
      .map((step) => byId(step.itemId))
      .find((candidate) => candidate !== undefined && !seen.includes(candidate));
    return next ? walk(next, [...seen, next]) : seen;
  };
  const first = workflow.operations[0];
  return first ? walk(first, [first]) : [];
};

/** One row per outcome: each choice for a single question, each named route for several. */
export const outcomeRowsOf = (operation: Operation): readonly Condition[] => {
  const [only] = operation.questions;
  if (operation.questions.length === 1 && only) {
    return only.choices.map((choice): Condition => ({ [only.id]: choice.id }));
  }
  return operation.routes.map((route) => route.when).filter((when) => Object.keys(when).length > 0);
};

export type ConsequenceKind = "operation" | "approval" | "notification" | "stop" | "action" | "nothing";

export interface Consequence {
  readonly kind: ConsequenceKind;
  readonly name: string;
  readonly step: CatalogChoice | null;
  /** How many other steps the outcome also runs. */
  readonly more: number;
}

const kindOf = (step: CatalogChoice): ConsequenceKind => {
  if (isHandOff(step)) return "operation";
  if (step.groupId !== "cogwork") return "action";
  if (step.itemId === "approve") return "approval";
  if (step.itemId === "notify") return "notification";
  if (step.itemId === "stop") return "stop";
  return "action";
};

const rank: readonly ConsequenceKind[] = ["operation", "approval", "notification", "stop", "action"];

/** Where an outcome leads, named by its most consequential step: a hand-off before a pause, a pause before an Action. */
export const consequenceOf = (operation: Operation, when: Condition): Consequence => {
  const steps = stepsAt(operation, when);
  const [lead] = [...steps].sort((a, b) => rank.indexOf(kindOf(a)) - rank.indexOf(kindOf(b)));
  if (!lead) return { kind: "nothing", name: "Does nothing", step: null, more: 0 };
  const name = lead.optionName ? `${lead.itemName} ${lead.optionName}` : lead.itemName;
  return { kind: kindOf(lead), name, step: lead, more: steps.length - 1 };
};

export const outcomeCount = (workflow: Workflow) =>
  workflow.operations.reduce((total, operation) => total + outcomeRowsOf(operation).length, 0);

export const workspaceScope = (workflow: Workflow, every: number) => {
  const [only] = workflow.workspaces;
  if (workflow.workspaces.length === 0 || !only) return "No workspace";
  if (workflow.workspaces.length === every) return "Every workspace";
  if (workflow.workspaces.length === 1) return only;
  return `${workflow.workspaces.length} workspaces`;
};
