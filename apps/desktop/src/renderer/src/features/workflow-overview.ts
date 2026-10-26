import { type CatalogChoice, isHandOff } from "./workflow-catalog";
import { actionsAt, type Condition, type Operation, type Workflow } from "./workflow-model";

const handOffPath = (workflow: Workflow) => {
  const byId = (id: string) => workflow.operations.find((operation) => operation.id === id);
  const walk = (operation: Operation, seen: readonly Operation[]): readonly Operation[] => {
    const next = operation.routes
      .flatMap((route) => route.actions.filter(isHandOff))
      .map((action) => byId(action.itemId))
      .find((candidate) => candidate !== undefined && !seen.includes(candidate));
    return next ? walk(next, [...seen, next]) : seen;
  };
  const first = workflow.operations[0];
  return first ? walk(first, [first]) : [];
};

export const operationsInOrder = (workflow: Workflow) => {
  const path = handOffPath(workflow);
  return [...path, ...workflow.operations.filter((operation) => !path.includes(operation))];
};

export const outcomeRowsOf = (operation: Operation): readonly Condition[] => {
  const [only] = operation.questions;
  if (operation.questions.length === 1 && only) {
    return only.choices.map((choice): Condition => ({ [only.id]: choice.id }));
  }
  return operation.routes.map((route) => route.when).filter((when) => Object.keys(when).length > 0);
};

export type ConsequenceKind = "operation" | "approval" | "notification" | "stop" | "action" | "nothing";

const cogworkActionKinds: Readonly<Record<string, ConsequenceKind>> = {
  "cogwork/approve": "approval",
  "cogwork/notify": "notification",
  "cogwork/stop": "stop",
};

const kindOf = (action: CatalogChoice) =>
  isHandOff(action) ? "operation" : (cogworkActionKinds[`${action.groupId}/${action.itemId}`] ?? "action");

const rank: readonly ConsequenceKind[] = ["operation", "approval", "notification", "stop", "action"];

export const consequenceOf = (operation: Operation, when: Condition) => {
  const [lead] = actionsAt(operation, when).toSorted(
    (a, b) => rank.indexOf(kindOf(a)) - rank.indexOf(kindOf(b)),
  );
  if (!lead) return { kind: "nothing" as const, name: "Nothing", action: null };
  const name = lead.optionName ? `${lead.itemName} ${lead.optionName}` : lead.itemName;
  return { kind: kindOf(lead), name, action: lead };
};
