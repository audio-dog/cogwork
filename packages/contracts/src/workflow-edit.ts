import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./base-schemas";
import { RunPlanPolicyProfile } from "./settings";
import {
  NeedIdentity,
  WorkflowAction,
  WorkflowCatalogKey,
  type WorkflowDocument,
  WorkflowModelSelection,
  WorkflowNodeId,
  WorkflowOperation,
  WorkflowQuestion,
  WorkflowQuestionChoice,
  type WorkflowTransition,
  WorkflowTransitionAnswer,
  WorkflowTrigger,
  WorkflowTriggerFilter,
  WorkflowWorkspaceSelection,
} from "./workflow";
import { type Decoded, decodeWorkflowDocumentValue, ok, refused, unknownTarget } from "./workflow-diagnostic";
import { transitionKey } from "./workflow-operation-result";
import {
  duplicateIdDiagnostics,
  duplicateTransitionDiagnostics,
  referenceDiagnostics,
  selfHandOffDiagnostics,
} from "./workflow-validation";

export const WorkflowEdit = Schema.TaggedUnion({
  Rename: { name: TrimmedNonEmptyString },
  SelectWorkspaces: { workspaces: WorkflowWorkspaceSelection },
  AddTrigger: { trigger: WorkflowTrigger },
  RemoveTrigger: { trigger: WorkflowNodeId },
  SetTriggerEntry: { trigger: WorkflowNodeId, entry: WorkflowCatalogKey },
  SetTriggerParameter: {
    trigger: WorkflowNodeId,
    parameter: TrimmedNonEmptyString,
    values: Schema.Array(Schema.String),
  },
  SetTriggerStart: { trigger: WorkflowNodeId, start: WorkflowNodeId },
  AddTriggerFilter: { trigger: WorkflowNodeId, filter: WorkflowTriggerFilter },
  RemoveTriggerFilter: { trigger: WorkflowNodeId, entry: WorkflowCatalogKey },
  AddOperation: { operation: WorkflowOperation },
  RemoveOperation: { operation: WorkflowNodeId },
  RenameOperation: { operation: WorkflowNodeId, name: TrimmedNonEmptyString },
  SetInstruction: { operation: WorkflowNodeId, instruction: Schema.String },
  SetInstructionPackage: {
    operation: WorkflowNodeId,
    package: Schema.NullOr(TrimmedNonEmptyString),
  },
  SetPermissionProfile: { operation: WorkflowNodeId, profile: RunPlanPolicyProfile },
  SetRequires: { operation: WorkflowNodeId, requires: Schema.Array(NeedIdentity) },
  SetModel: { operation: WorkflowNodeId, model: WorkflowModelSelection },
  SetForEach: { operation: WorkflowNodeId, forEach: Schema.NullOr(TrimmedNonEmptyString) },
  AddQuestion: { operation: WorkflowNodeId, question: WorkflowQuestion },
  RemoveQuestion: { operation: WorkflowNodeId, question: WorkflowNodeId },
  SetQuestionText: {
    operation: WorkflowNodeId,
    question: WorkflowNodeId,
    text: TrimmedNonEmptyString,
  },
  AddChoice: {
    operation: WorkflowNodeId,
    question: WorkflowNodeId,
    choice: WorkflowQuestionChoice,
  },
  RemoveChoice: {
    operation: WorkflowNodeId,
    question: WorkflowNodeId,
    choice: WorkflowNodeId,
  },
  RenameChoice: {
    operation: WorkflowNodeId,
    question: WorkflowNodeId,
    choice: WorkflowNodeId,
    name: TrimmedNonEmptyString,
  },
  AddTransition: {
    operation: WorkflowNodeId,
    when: Schema.Array(WorkflowTransitionAnswer),
  },
  RemoveTransition: {
    operation: WorkflowNodeId,
    when: Schema.Array(WorkflowTransitionAnswer),
  },
  SetTransitionActions: {
    operation: WorkflowNodeId,
    when: Schema.Array(WorkflowTransitionAnswer),
    actions: Schema.Array(WorkflowAction),
  },
  SetTransitionHandOff: {
    operation: WorkflowNodeId,
    when: Schema.Array(WorkflowTransitionAnswer),
    handOff: Schema.NullOr(WorkflowNodeId),
  },
  SetHint: {
    operation: WorkflowNodeId,
    field: TrimmedNonEmptyString,
    text: Schema.NullOr(TrimmedNonEmptyString),
  },
});
export type WorkflowEdit = typeof WorkflowEdit.Type;

export const WorkflowEditBatch = Schema.NonEmptyArray(WorkflowEdit);
export type WorkflowEditBatch = typeof WorkflowEditBatch.Type;

const updateById = <A extends { readonly id: string }>(
  values: ReadonlyArray<A>,
  id: string,
  field: string,
  update: (value: A) => A,
): Decoded<ReadonlyArray<A>> =>
  values.some((value) => value.id === id)
    ? ok(values.map((value) => (value.id === id ? update(value) : value)))
    : refused([unknownTarget(id, field)]);

const updateOperation = (
  document: WorkflowDocument,
  operation: WorkflowNodeId,
  update: (value: WorkflowOperation) => WorkflowOperation,
): Decoded<WorkflowDocument> => {
  const operations = updateById(document.operations, operation, "operation", update);
  return operations._tag === "Ok" ? ok({ ...document, operations: operations.value }) : operations;
};

const updateTrigger = (
  document: WorkflowDocument,
  trigger: WorkflowNodeId,
  update: (value: WorkflowTrigger) => WorkflowTrigger,
): Decoded<WorkflowDocument> => {
  const triggers = updateById(document.triggers, trigger, "trigger", update);
  return triggers._tag === "Ok" ? ok({ ...document, triggers: triggers.value }) : triggers;
};

const withQuestion = (
  document: WorkflowDocument,
  operation: WorkflowNodeId,
  question: WorkflowNodeId,
  update: (value: WorkflowQuestion) => WorkflowQuestion,
): Decoded<WorkflowDocument> => {
  const selectedOperation = document.operations.find(({ id }) => id === operation);
  if (!selectedOperation) return refused([unknownTarget(operation, "operation")]);
  const questions = updateById(selectedOperation.questions, question, "question", update);
  if (questions._tag === "Refused") return questions;
  return updateOperation(document, operation, (value) => ({ ...value, questions: questions.value }));
};

const withChoice = (
  document: WorkflowDocument,
  operation: WorkflowNodeId,
  question: WorkflowNodeId,
  choice: WorkflowNodeId,
  update: (value: WorkflowQuestionChoice) => WorkflowQuestionChoice,
): Decoded<WorkflowDocument> => {
  const selectedOperation = document.operations.find(({ id }) => id === operation);
  if (!selectedOperation) return refused([unknownTarget(operation, "operation")]);
  const selectedQuestion = selectedOperation.questions.find(({ id }) => id === question);
  if (!selectedQuestion) return refused([unknownTarget(question, "question")]);
  const choices = updateById(selectedQuestion.choices, choice, "choice", update);
  if (choices._tag === "Refused") return choices;
  return withQuestion(document, operation, question, (value) => ({ ...value, choices: choices.value }));
};

const withTransition = (
  document: WorkflowDocument,
  operation: WorkflowNodeId,
  when: ReadonlyArray<WorkflowTransitionAnswer>,
  update: (value: WorkflowTransition) => WorkflowTransition,
): Decoded<WorkflowDocument> => {
  const selectedOperation = document.operations.find(({ id }) => id === operation);
  if (!selectedOperation) return refused([unknownTarget(operation, "operation")]);
  const key = transitionKey({ when });
  const hasTransition = selectedOperation.transitions.some((value) => transitionKey(value) === key);
  if (!hasTransition) return refused([unknownTarget(key, "transition")]);
  return updateOperation(document, operation, (value) => ({
    ...value,
    transitions: value.transitions.map((transition) =>
      transitionKey(transition) === key ? update(transition) : transition,
    ),
  }));
};

const setTriggerParameter = (
  trigger: WorkflowTrigger,
  parameter: string,
  values: ReadonlyArray<string>,
): WorkflowTrigger => ({
  ...trigger,
  parameters: [
    ...trigger.parameters.filter(({ id }) => id !== parameter),
    ...values.map((value) => ({ id: parameter, value })),
  ],
});

const removeQuestion = (
  document: WorkflowDocument,
  operation: WorkflowNodeId,
  question: WorkflowNodeId,
): Decoded<WorkflowDocument> => {
  const selected = withQuestion(document, operation, question, (value) => value);
  if (selected._tag === "Refused") return selected;
  return updateOperation(document, operation, (value) => ({
    ...value,
    questions: value.questions.filter(({ id }) => id !== question),
    transitions: value.transitions.filter((transition) =>
      transition.when.every((answer) => answer.question !== question),
    ),
  }));
};

const removeTransition = (
  document: WorkflowDocument,
  operation: WorkflowNodeId,
  when: ReadonlyArray<WorkflowTransitionAnswer>,
): Decoded<WorkflowDocument> => {
  const selected = withTransition(document, operation, when, (value) => value);
  if (selected._tag === "Refused") return selected;
  const key = transitionKey({ when });
  return updateOperation(document, operation, (value) => ({
    ...value,
    transitions: value.transitions.filter((transition) => transitionKey(transition) !== key),
  }));
};

const applyWorkflowEdit = (document: WorkflowDocument, edit: WorkflowEdit): Decoded<WorkflowDocument> =>
  WorkflowEdit.match(edit, {
    Rename: ({ name }) => ok({ ...document, name }),
    SelectWorkspaces: ({ workspaces }) => ok({ ...document, workspaces }),
    AddTrigger: ({ trigger }) => ok({ ...document, triggers: [...document.triggers, trigger] }),
    RemoveTrigger: ({ trigger }) => {
      const triggers = document.triggers.filter(({ id }) => id !== trigger);
      return triggers.length === document.triggers.length
        ? refused<WorkflowDocument>([unknownTarget(trigger, "trigger")])
        : ok({ ...document, triggers });
    },
    SetTriggerEntry: ({ trigger, entry }) =>
      updateTrigger(document, trigger, (value) => ({ ...value, entry, parameters: [], filters: [] })),
    AddTriggerFilter: ({ trigger, filter }) =>
      updateTrigger(document, trigger, (value) => ({
        ...value,
        filters: [...value.filters.filter(({ entry }) => entry !== filter.entry), filter],
      })),
    RemoveTriggerFilter: ({ trigger, entry }) =>
      updateTrigger(document, trigger, (value) => ({
        ...value,
        filters: value.filters.filter((filter) => filter.entry !== entry),
      })),
    SetTriggerParameter: ({ trigger, parameter, values }) =>
      updateTrigger(document, trigger, (value) => setTriggerParameter(value, parameter, values)),
    SetTriggerStart: ({ trigger, start }) =>
      updateTrigger(document, trigger, (value) => ({ ...value, start })),
    AddOperation: ({ operation }) => ok({ ...document, operations: [...document.operations, operation] }),
    RemoveOperation: ({ operation }) => {
      const operations = document.operations
        .filter(({ id }) => id !== operation)
        .map((value) => ({
          ...value,
          transitions: value.transitions.map((transition) => ({
            ...transition,
            handOff: transition.handOff === operation ? null : transition.handOff,
          })),
        }));
      return operations.length === document.operations.length
        ? refused<WorkflowDocument>([unknownTarget(operation, "operation")])
        : ok({ ...document, operations });
    },
    RenameOperation: ({ operation, name }) =>
      updateOperation(document, operation, (value) => ({ ...value, name })),
    SetInstruction: ({ operation, instruction }) =>
      updateOperation(document, operation, (value) => ({ ...value, instruction })),
    SetInstructionPackage: ({ operation, package: instructionPackage }) =>
      updateOperation(document, operation, (value) => ({ ...value, instructionPackage })),
    SetPermissionProfile: ({ operation, profile: permissionProfile }) =>
      updateOperation(document, operation, (value) => ({ ...value, permissionProfile })),
    SetRequires: ({ operation, requires }) =>
      updateOperation(document, operation, (value) => ({ ...value, requires })),
    SetModel: ({ operation, model }) =>
      updateOperation(document, operation, (value) => ({ ...value, model })),
    SetForEach: ({ operation, forEach }) =>
      updateOperation(document, operation, (value) => ({ ...value, forEach })),
    AddQuestion: ({ operation, question }) =>
      updateOperation(document, operation, (value) => ({
        ...value,
        questions: [...value.questions, question],
      })),
    RemoveQuestion: ({ operation, question }) => removeQuestion(document, operation, question),
    SetQuestionText: ({ operation, question, text }) =>
      withQuestion(document, operation, question, (value) => ({ ...value, text })),
    AddChoice: ({ operation, question, choice }) =>
      withQuestion(document, operation, question, (value) => ({
        ...value,
        choices: [...value.choices, choice],
      })),
    RemoveChoice: ({ operation, question, choice }) => {
      const selected = withChoice(document, operation, question, choice, (value) => value);
      if (selected._tag === "Refused") return selected;
      return updateOperation(document, operation, (value) => ({
        ...value,
        questions: value.questions.map((item) =>
          item.id === question ? { ...item, choices: item.choices.filter(({ id }) => id !== choice) } : item,
        ),
        transitions: value.transitions.filter((transition) =>
          transition.when.every((answer) => answer.question !== question || answer.choice !== choice),
        ),
      }));
    },
    RenameChoice: ({ operation, question, choice, name }) =>
      withChoice(document, operation, question, choice, (value) => ({ ...value, name })),
    AddTransition: ({ operation, when }) =>
      updateOperation(document, operation, (value) => ({
        ...value,
        transitions: [...value.transitions, { when, actions: [], handOff: null }],
      })),
    RemoveTransition: ({ operation, when }) => removeTransition(document, operation, when),
    SetTransitionActions: ({ operation, when, actions }) =>
      withTransition(document, operation, when, (value) => ({ ...value, actions })),
    SetTransitionHandOff: ({ operation, when, handOff }) =>
      withTransition(document, operation, when, (value) => ({ ...value, handOff })),
    SetHint: ({ operation, field, text }) =>
      updateOperation(document, operation, (value) => ({
        ...value,
        hints:
          text === null
            ? value.hints.filter((hint) => hint.field !== field)
            : [...value.hints.filter((hint) => hint.field !== field), { field, text }],
      })),
  });

export const applyWorkflowEdits = (
  document: WorkflowDocument,
  edits: WorkflowEditBatch,
): Decoded<WorkflowDocument> => {
  const result = edits.reduce<Decoded<WorkflowDocument>>(
    (result, edit) => (result._tag === "Refused" ? result : applyWorkflowEdit(result.value, edit)),
    ok(document),
  );
  if (result._tag === "Refused") return result;
  const decoded = decodeWorkflowDocumentValue(result.value);
  if (decoded._tag === "Refused") return decoded;
  const diagnostics = [
    ...duplicateIdDiagnostics(decoded.value),
    ...duplicateTransitionDiagnostics(decoded.value),
    ...referenceDiagnostics(decoded.value),
    ...selfHandOffDiagnostics(decoded.value),
  ];
  return diagnostics.length === 0 ? decoded : refused(diagnostics);
};
