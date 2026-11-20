import * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, type WorkspaceId } from "./base-schemas";
import {
  WorkflowNodeId,
  type WorkflowOperation,
  WorkflowReviewComment,
  type WorkflowTransition,
  type WorkflowTransitionAnswer,
} from "./workflow";
import type { WorkflowCatalog, WorkflowWorkspaceSource } from "./workflow-catalog";

const unique = <A>(values: ReadonlyArray<A>) => [...new Set(values)];

const objectFields = <A extends Schema.Top>(entries: ReadonlyArray<readonly [string, A]>) =>
  Object.fromEntries(entries);

const structOrEmpty = <A extends Schema.Top>(fields: Readonly<Record<string, A>>) =>
  Object.keys(fields).length === 0 ? Schema.Record(Schema.String, Schema.Never) : Schema.Struct(fields);

const answerFields = (operation: WorkflowOperation) =>
  objectFields(
    operation.questions.map(
      (question) => [question.id, Schema.Literals(question.choices.map(({ id }) => id))] as const,
    ),
  );

const operationActionEntries = (operation: WorkflowOperation, catalog: WorkflowCatalog) => {
  const actionKeys = new Set(
    operation.transitions.flatMap(({ actions }) => actions.map(({ entry }) => entry)),
  );
  return catalog.entries.filter(({ key, kind }) => kind === "action" && actionKeys.has(key));
};

const inputFields = (operation: WorkflowOperation, catalog: WorkflowCatalog) => {
  const inputs = unique(operationActionEntries(operation, catalog).flatMap(({ agentInputs }) => agentInputs));
  return objectFields(
    inputs.map((input) => [
      input,
      input === "review_comments" ? Schema.Array(WorkflowReviewComment) : Schema.String,
    ]),
  );
};

const agentChoosesWorkspaceFrom = {
  "item-else-agent": (itemWorkspace) => itemWorkspace === undefined,
  agent: () => true,
} satisfies Record<WorkflowWorkspaceSource, (itemWorkspace: WorkspaceId | undefined) => boolean>;

export const workflowOperationResultSchema = (
  operation: WorkflowOperation,
  catalog: WorkflowCatalog,
  workspaces: ReadonlyArray<WorkspaceId> = [],
  itemWorkspace?: WorkspaceId,
) => {
  const elementFields = {
    summary: TrimmedNonEmptyString,
    answers: structOrEmpty(answerFields(operation)),
    inputs: structOrEmpty(inputFields(operation, catalog)),
  };
  const entries = operationActionEntries(operation, catalog);
  const agentChoosesWorkspace = (workspace: WorkspaceId | undefined) =>
    entries.some(
      ({ workspaceSource }) =>
        workspaceSource !== null && agentChoosesWorkspaceFrom[workspaceSource](workspace),
    );
  const element = agentChoosesWorkspace(undefined)
    ? Schema.Struct({ ...elementFields, workspace: Schema.Literals(["none", ...workspaces]) })
    : Schema.Struct(elementFields);
  const once = agentChoosesWorkspace(itemWorkspace)
    ? Schema.Struct({
        summary: TrimmedNonEmptyString,
        stuck: Schema.Boolean,
        answers: elementFields.answers,
        inputs: elementFields.inputs,
        workspace: Schema.Literals(["none", ...workspaces]),
      })
    : Schema.Struct({
        summary: TrimmedNonEmptyString,
        stuck: Schema.Boolean,
        answers: elementFields.answers,
        inputs: elementFields.inputs,
      });
  return operation.forEach === null
    ? once
    : Schema.Struct({
        summary: TrimmedNonEmptyString,
        stuck: Schema.Boolean,
        elements: Schema.Array(element).check(Schema.isMaxLength(50)),
      });
};

export const workflowOperationResultJsonSchema = (
  operation: WorkflowOperation,
  catalog: WorkflowCatalog,
  workspaces: ReadonlyArray<WorkspaceId> = [],
  itemWorkspace?: WorkspaceId,
) => {
  const document = Schema.toJsonSchemaDocument(
    workflowOperationResultSchema(operation, catalog, workspaces, itemWorkspace),
    { onExcessProperty: "error" },
  );
  const schema: JsonSchema.JsonSchema = {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    ...document.schema,
  };
  return Object.keys(document.definitions).length === 0 ? schema : { ...schema, $defs: document.definitions };
};

export const matchWorkflowTransitions = (
  operation: WorkflowOperation,
  answers: Readonly<Record<string, string>>,
) =>
  operation.transitions.filter((transition) =>
    transitionMatches(
      transition,
      Object.entries(answers).map(([question, choice]) => ({
        question: Schema.decodeSync(WorkflowNodeId)(question),
        choice: Schema.decodeSync(WorkflowNodeId)(choice),
      })),
    ),
  );

export const transitionKey = (transition: Pick<WorkflowTransition, "when">) =>
  JSON.stringify(
    [...transition.when]
      .sort((left, right) => left.question.localeCompare(right.question))
      .map(({ question, choice }) => [question, choice]),
  );

export const answerCombinations = (operation: WorkflowOperation) =>
  operation.questions.reduce<ReadonlyArray<ReadonlyArray<WorkflowTransitionAnswer>>>(
    (combinations, question) =>
      combinations.flatMap((combination) =>
        question.choices.map((choice) => [...combination, { question: question.id, choice: choice.id }]),
      ),
    [[]],
  );

export const transitionMatches = (
  transition: WorkflowTransition,
  answers: ReadonlyArray<WorkflowTransitionAnswer>,
) =>
  transition.when.every((condition) =>
    answers.some((answer) => answer.question === condition.question && answer.choice === condition.choice),
  );

export const uncovered = (operation: WorkflowOperation) => {
  const hasQuestionWithoutChoices = operation.questions.some(({ choices }) => choices.length === 0);
  if (hasQuestionWithoutChoices) return [[]];
  return answerCombinations(operation).filter(
    (answers) =>
      !operation.transitions.some(
        (transition) =>
          transitionMatches(transition, answers) &&
          (transition.actions.length > 0 || transition.handOff !== null),
      ),
  );
};
