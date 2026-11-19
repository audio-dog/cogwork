import type { WorkflowDocument, WorkflowNodeId, WorkflowOperation } from "@cogwork/contracts";
import { Array as Arr, Option, pipe, String as Str } from "effect";

// These ids name a person or a machine. Labels and authors are shared conventions, so they travel quietly.
const personalParameterIds = ["bot", "channel", "reviewer"];

const filledPersonalParameter = (parameter: { readonly id: string; readonly value: string }) =>
  Arr.contains(personalParameterIds, parameter.id) && Str.isNonEmpty(Str.trim(parameter.value));

export const importReviewMark = {
  workspaces: "workspaces",
  model: (operation: WorkflowNodeId) => `model:${operation}`,
  requires: (operation: WorkflowNodeId) => `requires:${operation}`,
  triggerParameter: (trigger: WorkflowNodeId, parameter: string) => `trigger:${trigger}:${parameter}`,
  actionParameter: (operation: WorkflowNodeId, transition: number, action: number, parameter: string) =>
    `action:${operation}:${transition}:${action}:${parameter}`,
} as const;

const filledPersonalMarks = (
  parameters: ReadonlyArray<{ readonly id: string; readonly value: string }>,
  mark: (parameter: string) => string,
) =>
  pipe(
    parameters,
    Arr.filter(filledPersonalParameter),
    Arr.map(({ id }) => mark(id)),
  );

const listedWorkspaceMark = (document: WorkflowDocument) =>
  pipe(
    Option.liftPredicate(
      document.workspaces,
      (workspaces) => workspaces._tag === "Listed" && Arr.isReadonlyArrayNonEmpty(workspaces.workspaces),
    ),
    Option.map(() => importReviewMark.workspaces),
  );

const triggerMarks = (document: WorkflowDocument) =>
  Arr.flatMap(document.triggers, (trigger) =>
    filledPersonalMarks(trigger.parameters, (parameter) =>
      importReviewMark.triggerParameter(trigger.id, parameter),
    ),
  );

const namedModel = (operation: WorkflowOperation) =>
  operation.model.harness !== null || operation.model.model !== null;

const modelMark = (operation: WorkflowOperation) =>
  pipe(
    Option.liftPredicate(operation, namedModel),
    Option.map(({ id }) => importReviewMark.model(id)),
  );

const requiresMark = (operation: WorkflowOperation) =>
  pipe(
    Option.liftPredicate(operation, ({ requires }) => Arr.isReadonlyArrayNonEmpty(requires)),
    Option.map(({ id }) => importReviewMark.requires(id)),
  );

const actionMarks = (operation: WorkflowOperation) =>
  Arr.flatMap(operation.transitions, (transition, transitionIndex) =>
    Arr.flatMap(transition.actions, (action, actionIndex) =>
      filledPersonalMarks(action.parameters, (parameter) =>
        importReviewMark.actionParameter(operation.id, transitionIndex, actionIndex, parameter),
      ),
    ),
  );

const operationMarks = (operation: WorkflowOperation) => [
  ...Arr.getSomes([modelMark(operation), requiresMark(operation)]),
  ...actionMarks(operation),
];

export const importReviewMarks = (document: WorkflowDocument) => [
  ...Option.toArray(listedWorkspaceMark(document)),
  ...triggerMarks(document),
  ...Arr.flatMap(document.operations, operationMarks),
];
