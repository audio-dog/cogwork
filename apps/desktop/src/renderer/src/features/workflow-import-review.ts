import type { WorkflowDocument, WorkflowNodeId, WorkflowOperation } from "@cogwork/contracts";

// These ids name a person or a machine. Labels and authors are shared conventions, so they travel quietly.
const personalParameter = (id: string) => id === "bot" || id === "channel" || id === "reviewer";

const filledPersonalParameter = (parameter: { readonly id: string; readonly value: string }) =>
  personalParameter(parameter.id) && parameter.value.trim().length > 0;

export const importReviewMark = {
  workspaces: "workspaces",
  model: (operation: WorkflowNodeId) => `model:${operation}`,
  requires: (operation: WorkflowNodeId) => `requires:${operation}`,
  triggerParameter: (trigger: WorkflowNodeId, parameter: string) => `trigger:${trigger}:${parameter}`,
  actionParameter: (operation: WorkflowNodeId, transition: number, action: number, parameter: string) =>
    `action:${operation}:${transition}:${action}:${parameter}`,
} as const;

const listedWorkspaceMark = (document: WorkflowDocument) => {
  if (document.workspaces._tag !== "Listed") return [];
  if (document.workspaces.workspaces.length === 0) return [];
  return [importReviewMark.workspaces];
};

const triggerMarks = (document: WorkflowDocument) =>
  document.triggers.flatMap((trigger) =>
    trigger.parameters.flatMap((parameter) =>
      filledPersonalParameter(parameter) ? [importReviewMark.triggerParameter(trigger.id, parameter.id)] : [],
    ),
  );

const namedModel = (operation: WorkflowOperation) =>
  operation.model.harness !== null || operation.model.model !== null;

const actionMarks = (operation: WorkflowOperation) =>
  operation.transitions.flatMap((transition, transitionIndex) =>
    transition.actions.flatMap((action, actionIndex) =>
      action.parameters.flatMap((parameter) =>
        filledPersonalParameter(parameter)
          ? [importReviewMark.actionParameter(operation.id, transitionIndex, actionIndex, parameter.id)]
          : [],
      ),
    ),
  );

const operationMarks = (operation: WorkflowOperation) => [
  ...(namedModel(operation) ? [importReviewMark.model(operation.id)] : []),
  ...(operation.requires.length > 0 ? [importReviewMark.requires(operation.id)] : []),
  ...actionMarks(operation),
];

export const importReviewMarks = (document: WorkflowDocument) => [
  ...listedWorkspaceMark(document),
  ...triggerMarks(document),
  ...document.operations.flatMap(operationMarks),
];
