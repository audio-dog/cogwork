import { type CatalogChoice, isHandOff } from "./workflow-catalog";
import { type Condition, type Operation, stepsAt, type Workflow } from "./workflow-model";

export const spineOf = (workflow: Workflow) => {
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

export const outcomeRowsOf = (operation: Operation) => {
  const [only] = operation.questions;
  if (operation.questions.length === 1 && only) {
    return only.choices.map((choice): Condition => ({ [only.id]: choice.id }));
  }
  return operation.routes.map((route) => route.when).filter((when) => Object.keys(when).length > 0);
};

export type ConsequenceKind = "operation" | "approval" | "notification" | "stop" | "action" | "nothing";

const cogworkStepKinds: Readonly<Record<string, ConsequenceKind>> = {
  "cogwork/approve": "approval",
  "cogwork/notify": "notification",
  "cogwork/stop": "stop",
};

const kindOf = (step: CatalogChoice) =>
  isHandOff(step) ? "operation" : (cogworkStepKinds[`${step.groupId}/${step.itemId}`] ?? "action");

const rank: readonly ConsequenceKind[] = ["operation", "approval", "notification", "stop", "action"];

export const consequenceOf = (operation: Operation, when: Condition) => {
  const [lead] = stepsAt(operation, when).toSorted(
    (a, b) => rank.indexOf(kindOf(a)) - rank.indexOf(kindOf(b)),
  );
  if (!lead) return { kind: "nothing" as const, name: "Nothing", step: null };
  const name = lead.optionName ? `${lead.itemName} ${lead.optionName}` : lead.itemName;
  return { kind: kindOf(lead), name, step: lead };
};
