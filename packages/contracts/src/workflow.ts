import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { HarnessName, TrimmedNonEmptyString, WorkspaceId } from "./base-schemas";
import { PrincipalId } from "./principal";
import { RunPlanPolicyProfile } from "./settings";

export const WorkflowId = TrimmedNonEmptyString.pipe(Schema.brand("WorkflowId"));
export type WorkflowId = typeof WorkflowId.Type;

export const WorkflowNodeId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
).pipe(Schema.brand("WorkflowNodeId"));
export type WorkflowNodeId = typeof WorkflowNodeId.Type;

export const WorkflowCatalogKey = TrimmedNonEmptyString.pipe(Schema.brand("WorkflowCatalogKey"));
export type WorkflowCatalogKey = typeof WorkflowCatalogKey.Type;

export const WorkflowParameterValue = Schema.Struct({
  id: TrimmedNonEmptyString,
  value: Schema.String,
});
export type WorkflowParameterValue = typeof WorkflowParameterValue.Type;

export const WorkflowWorkspaceSelection = Schema.Union([
  Schema.TaggedStruct("Every", {}),
  Schema.TaggedStruct("Listed", { workspaces: Schema.Array(WorkspaceId) }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type WorkflowWorkspaceSelection = typeof WorkflowWorkspaceSelection.Type;

export const WorkflowTrigger = Schema.Struct({
  id: WorkflowNodeId,
  entry: WorkflowCatalogKey,
  parameters: Schema.Array(WorkflowParameterValue),
  start: WorkflowNodeId,
});
export type WorkflowTrigger = typeof WorkflowTrigger.Type;

export const WorkflowQuestionChoice = Schema.Struct({
  id: WorkflowNodeId,
  name: TrimmedNonEmptyString,
});
export type WorkflowQuestionChoice = typeof WorkflowQuestionChoice.Type;

export const WorkflowQuestion = Schema.Struct({
  id: WorkflowNodeId,
  text: TrimmedNonEmptyString,
  choices: Schema.Array(WorkflowQuestionChoice),
});
export type WorkflowQuestion = typeof WorkflowQuestion.Type;

const boundedAnswerSpace = Schema.makeFilter((questions: ReadonlyArray<WorkflowQuestion>) => {
  const combinations = questions.reduce(
    (count, question) => Math.min(count * question.choices.length, 4097),
    1,
  );
  return combinations <= 4096 ? undefined : "Expected at most 4096 answer combinations";
});

export const WorkflowTransitionAnswer = Schema.Struct({
  question: WorkflowNodeId,
  choice: WorkflowNodeId,
});
export type WorkflowTransitionAnswer = typeof WorkflowTransitionAnswer.Type;

export const WorkflowAction = Schema.Struct({
  entry: WorkflowCatalogKey,
  parameters: Schema.Array(WorkflowParameterValue),
});
export type WorkflowAction = typeof WorkflowAction.Type;

export const WorkflowTransition = Schema.Struct({
  when: Schema.Array(WorkflowTransitionAnswer),
  actions: Schema.Array(WorkflowAction),
  handOff: Schema.NullOr(WorkflowNodeId),
});
export type WorkflowTransition = typeof WorkflowTransition.Type;

export const WorkflowHint = Schema.Struct({
  field: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
});
export type WorkflowHint = typeof WorkflowHint.Type;

export const WorkflowModelSelection = Schema.Struct({
  harness: Schema.NullOr(HarnessName),
  model: Schema.NullOr(TrimmedNonEmptyString),
  options: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      value: Schema.Union([TrimmedNonEmptyString, Schema.Boolean]),
    }),
  ),
});
export type WorkflowModelSelection = typeof WorkflowModelSelection.Type;

export const WorkflowOperation = Schema.Struct({
  id: WorkflowNodeId,
  name: TrimmedNonEmptyString,
  instructionPackage: Schema.NullOr(TrimmedNonEmptyString),
  instruction: Schema.String,
  permissionProfile: RunPlanPolicyProfile,
  requires: Schema.Array(TrimmedNonEmptyString),
  model: WorkflowModelSelection,
  forEach: Schema.NullOr(TrimmedNonEmptyString),
  questions: Schema.Array(WorkflowQuestion).check(boundedAnswerSpace),
  transitions: Schema.Array(WorkflowTransition),
  hints: Schema.Array(WorkflowHint),
});
export type WorkflowOperation = typeof WorkflowOperation.Type;

export const WorkflowDocument = Schema.Struct({
  name: TrimmedNonEmptyString,
  workspaces: WorkflowWorkspaceSelection,
  triggers: Schema.Array(WorkflowTrigger),
  operations: Schema.Array(WorkflowOperation),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type WorkflowDocument = typeof WorkflowDocument.Type;

export const WorkflowEdit = Schema.TaggedUnion({
  SetName: { name: TrimmedNonEmptyString },
  SetWorkspaces: { workspaces: WorkflowWorkspaceSelection },
  AddTrigger: { trigger: WorkflowTrigger },
  ReplaceTrigger: { id: WorkflowNodeId, trigger: WorkflowTrigger },
  RemoveTrigger: { id: WorkflowNodeId },
  AddOperation: { operation: WorkflowOperation },
  ReplaceOperation: { id: WorkflowNodeId, operation: WorkflowOperation },
  RemoveOperation: { id: WorkflowNodeId },
});
export type WorkflowEdit = typeof WorkflowEdit.Type;

export const WorkflowEditBatch = Schema.NonEmptyArray(WorkflowEdit).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type WorkflowEditBatch = typeof WorkflowEditBatch.Type;

export const WorkflowDiagnosticCode = Schema.Literals([
  "schema",
  "unknown-target",
  "duplicate-id",
  "duplicate-transition",
  "unknown-reference",
  "self-hand-off",
  "unknown-catalog-entry",
  "unknown-option",
  "unknown-model",
  "no-trigger",
  "uncovered-outcome",
  "conflicting-hand-offs",
  "empty-instruction",
  "missing-option",
  "profile-too-narrow",
  "no-workspace",
  "item-kind-mismatch",
  "connection-not-ready",
  "need-not-ready",
  "harness-unavailable",
  "no-harness",
  "workspace-not-registered",
  "system-unbound",
  "unreachable-operation",
  "option-not-listed",
  "hand-off-and-trigger",
]);
export type WorkflowDiagnosticCode = typeof WorkflowDiagnosticCode.Type;

export const WorkflowDiagnosticClass = Schema.Literals(["malformed", "incomplete", "advisory"]);
export type WorkflowDiagnosticClass = typeof WorkflowDiagnosticClass.Type;

export const WorkflowDiagnosticLocation = Schema.Struct({
  trigger: Schema.NullOr(WorkflowNodeId),
  operation: Schema.NullOr(WorkflowNodeId),
  question: Schema.NullOr(WorkflowNodeId),
  choice: Schema.NullOr(WorkflowNodeId),
  field: Schema.String,
});
export type WorkflowDiagnosticLocation = typeof WorkflowDiagnosticLocation.Type;

export const WorkflowDiagnostic = Schema.Struct({
  code: WorkflowDiagnosticCode,
  class: WorkflowDiagnosticClass,
  location: WorkflowDiagnosticLocation,
  message: TrimmedNonEmptyString,
});
export type WorkflowDiagnostic = typeof WorkflowDiagnostic.Type;

export const WorkflowCatalogParameter = Schema.Struct({
  id: TrimmedNonEmptyString,
  required: Schema.Boolean,
  source: Schema.Literals(["fixed", "live"]),
  values: Schema.Array(Schema.String),
});
export type WorkflowCatalogParameter = typeof WorkflowCatalogParameter.Type;

export const WorkflowCatalogEntry = Schema.Struct({
  key: WorkflowCatalogKey,
  name: TrimmedNonEmptyString,
  kind: Schema.Literals(["trigger", "action"]),
  system: Schema.NullOr(TrimmedNonEmptyString),
  connection: Schema.NullOr(TrimmedNonEmptyString),
  requires: Schema.Array(TrimmedNonEmptyString),
  parameters: Schema.Array(WorkflowCatalogParameter),
  itemKind: Schema.NullOr(TrimmedNonEmptyString),
  actsOn: Schema.Array(TrimmedNonEmptyString),
  requiresWorkspace: Schema.Boolean,
  permissionProfile: RunPlanPolicyProfile,
  agentInputs: Schema.Array(TrimmedNonEmptyString),
  emits: Schema.Array(WorkflowCatalogKey),
});
export type WorkflowCatalogEntry = typeof WorkflowCatalogEntry.Type;

export const WorkflowCatalogModel = Schema.Struct({
  harness: HarnessName,
  available: Schema.Boolean,
  models: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      options: Schema.Array(
        Schema.Struct({
          id: TrimmedNonEmptyString,
          values: Schema.Array(Schema.Union([TrimmedNonEmptyString, Schema.Boolean])),
        }),
      ),
    }),
  ),
});
export type WorkflowCatalogModel = typeof WorkflowCatalogModel.Type;

export const WorkflowCatalog = Schema.Struct({
  entries: Schema.Array(WorkflowCatalogEntry),
  instructionPackages: Schema.Array(TrimmedNonEmptyString),
  models: Schema.Array(WorkflowCatalogModel),
  defaultHarness: Schema.NullOr(HarnessName),
  registeredWorkspaces: Schema.Array(WorkspaceId),
  systemBindings: Schema.Array(
    Schema.Struct({ system: TrimmedNonEmptyString, workspaces: Schema.Array(WorkspaceId) }),
  ),
  readyConnections: Schema.Array(TrimmedNonEmptyString),
  readyNeeds: Schema.Array(TrimmedNonEmptyString),
});
export type WorkflowCatalog = typeof WorkflowCatalog.Type;

export const WorkflowRecord = Schema.Struct({
  id: WorkflowId,
  principal: PrincipalId,
  workingCopy: WorkflowDocument,
  workingRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  publishedCopy: Schema.NullOr(WorkflowDocument),
  publishedRevision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  enabled: Schema.Boolean,
  diagnostics: Schema.Array(WorkflowDiagnostic),
});
export type WorkflowRecord = typeof WorkflowRecord.Type;

export const WorkflowReadFailure = Schema.Struct({
  id: Schema.String,
  message: TrimmedNonEmptyString,
});
export type WorkflowReadFailure = typeof WorkflowReadFailure.Type;

export const WorkflowList = Schema.Struct({
  workflows: Schema.Array(WorkflowRecord),
  failures: Schema.Array(WorkflowReadFailure),
});
export type WorkflowList = typeof WorkflowList.Type;

export const WorkflowSwitchResult = Schema.Struct({
  workflow: WorkflowRecord,
  matchingItems: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type WorkflowSwitchResult = typeof WorkflowSwitchResult.Type;

export class WorkflowNotFound extends Schema.TaggedError<WorkflowNotFound>()("WorkflowNotFound", {
  id: WorkflowId,
}) {}

export class WorkflowUnreadable extends Schema.TaggedError<WorkflowUnreadable>()("WorkflowUnreadable", {
  id: WorkflowId,
  message: TrimmedNonEmptyString,
}) {}

export class WorkflowEditRefused extends Schema.TaggedError<WorkflowEditRefused>()("WorkflowEditRefused", {
  diagnostics: Schema.Array(WorkflowDiagnostic),
}) {}

export class WorkflowPublishRefused extends Schema.TaggedError<WorkflowPublishRefused>()(
  "WorkflowPublishRefused",
  {
    reason: Schema.Literals(["stale-revision", "incomplete"]),
    expectedRevision: Schema.Int,
    actualRevision: Schema.Int,
    diagnostics: Schema.Array(WorkflowDiagnostic),
  },
) {}

export class WorkflowSwitchRefused extends Schema.TaggedError<WorkflowSwitchRefused>()(
  "WorkflowSwitchRefused",
  { id: WorkflowId, reason: Schema.Literal("no-published-revision") },
) {}

export const WorkflowFailure = Schema.Union([
  WorkflowNotFound,
  WorkflowUnreadable,
  WorkflowEditRefused,
  WorkflowPublishRefused,
  WorkflowSwitchRefused,
]);
export type WorkflowFailure = typeof WorkflowFailure.Type;

const rootLocation: WorkflowDiagnosticLocation = {
  trigger: null,
  operation: null,
  question: null,
  choice: null,
  field: "document",
} satisfies WorkflowDiagnosticLocation;

const location = (
  field: string,
  values: Partial<Pick<WorkflowDiagnosticLocation, "trigger" | "operation" | "question" | "choice">> = {},
) => ({ ...rootLocation, ...values, field });

const diagnostic = (
  code: WorkflowDiagnosticCode,
  diagnosticClass: WorkflowDiagnosticClass,
  message: string,
  diagnosticLocation: WorkflowDiagnosticLocation = rootLocation,
) => ({ code, class: diagnosticClass, location: diagnosticLocation, message }) satisfies WorkflowDiagnostic;

const unknownTarget = (target: string, field: string) =>
  diagnostic("unknown-target", "malformed", `No ${field} has id ${target}`, location(field));

const changedTarget = (target: string, field: string) =>
  diagnostic(
    "unknown-target",
    "malformed",
    `A replacement cannot change ${field} id ${target}`,
    location(field),
  );

const replaceById = <A extends { readonly id: string }>(
  values: ReadonlyArray<A>,
  id: string,
  replacement: A,
  field: string,
) => {
  const failure = [
    { matches: !values.some((value) => value.id === id), diagnostic: unknownTarget(id, field) },
    { matches: replacement.id !== id, diagnostic: changedTarget(id, field) },
  ].find(({ matches }) => matches);
  return failure?.diagnostic ?? values.map((value) => (value.id === id ? replacement : value));
};

const removeById = <A extends { readonly id: string }>(values: ReadonlyArray<A>, id: string) => {
  if (!values.some((value) => value.id === id)) return null;
  return values.filter((value) => value.id !== id);
};

export type WorkflowEditApplication =
  | { readonly _tag: "Applied"; readonly document: WorkflowDocument }
  | { readonly _tag: "Refused"; readonly diagnostics: ReadonlyArray<WorkflowDiagnostic> };

const applied = (document: WorkflowDocument): WorkflowEditApplication => ({
  _tag: "Applied",
  document,
});

const refused = (diagnostics: ReadonlyArray<WorkflowDiagnostic>): WorkflowEditApplication => ({
  _tag: "Refused",
  diagnostics,
});

const applyWorkflowEdit = (document: WorkflowDocument, edit: WorkflowEdit): WorkflowEditApplication =>
  WorkflowEdit.match(edit, {
    SetName: ({ name }) => applied({ ...document, name }),
    SetWorkspaces: ({ workspaces }) => applied({ ...document, workspaces }),
    AddTrigger: ({ trigger }) => applied({ ...document, triggers: [...document.triggers, trigger] }),
    ReplaceTrigger: ({ id, trigger }) => {
      const triggers = replaceById(document.triggers, id, trigger, "trigger");
      return Array.isArray(triggers) ? applied({ ...document, triggers }) : refused([triggers]);
    },
    RemoveTrigger: ({ id }) => {
      const triggers = removeById(document.triggers, id);
      return triggers === null ? refused([unknownTarget(id, "trigger")]) : applied({ ...document, triggers });
    },
    AddOperation: ({ operation }) =>
      applied({ ...document, operations: [...document.operations, operation] }),
    ReplaceOperation: ({ id, operation }) => {
      const operations = replaceById(document.operations, id, operation, "operation");
      return Array.isArray(operations) ? applied({ ...document, operations }) : refused([operations]);
    },
    RemoveOperation: ({ id }) => {
      const operations = removeById(document.operations, id);
      return operations === null
        ? refused([unknownTarget(id, "operation")])
        : applied({ ...document, operations });
    },
  });

export const applyWorkflowEdits = (
  document: WorkflowDocument,
  edits: ReadonlyArray<WorkflowEdit>,
): WorkflowEditApplication =>
  edits.reduce<WorkflowEditApplication>(
    (result, edit) => (result._tag === "Refused" ? result : applyWorkflowEdit(result.document, edit)),
    { _tag: "Applied", document },
  );

const duplicateValues = <A extends string>(values: ReadonlyArray<A>) =>
  values
    .filter((value, index) => values.indexOf(value) !== index)
    .filter((value, index, duplicates) => duplicates.indexOf(value) === index);

const transitionKey = (transition: WorkflowTransition) =>
  JSON.stringify(
    [...transition.when]
      .sort((left, right) => left.question.localeCompare(right.question))
      .map(({ question, choice }) => [question, choice]),
  );

const answerCombinations = (operation: WorkflowOperation) =>
  operation.questions.reduce<ReadonlyArray<ReadonlyArray<WorkflowTransitionAnswer>>>(
    (combinations, question) =>
      combinations.flatMap((combination) =>
        question.choices.map((choice) => [...combination, { question: question.id, choice: choice.id }]),
      ),
    [[]],
  );

const transitionMatches = (
  transition: WorkflowTransition,
  answers: ReadonlyArray<WorkflowTransitionAnswer>,
) =>
  transition.when.every((condition) =>
    answers.some((answer) => answer.question === condition.question && answer.choice === condition.choice),
  );

export const uncovered = (operation: WorkflowOperation) =>
  answerCombinations(operation).filter(
    (answers) =>
      !operation.transitions.some(
        (transition) =>
          transitionMatches(transition, answers) &&
          (transition.actions.length > 0 || transition.handOff !== null),
      ),
  );

const duplicateIdDiagnostics = (document: WorkflowDocument) => {
  const duplicateOperations = duplicateValues(document.operations.map(({ id }) => id));
  const duplicateTriggers = duplicateValues(document.triggers.map(({ id }) => id));
  const duplicateQuestions = document.operations.flatMap((operation) =>
    duplicateValues(operation.questions.map(({ id }) => id)).map((id) =>
      diagnostic(
        "duplicate-id",
        "malformed",
        `Operation ${operation.id} has duplicate question id ${id}`,
        location("question", { operation: operation.id, question: id }),
      ),
    ),
  );
  const duplicateChoices = document.operations.flatMap((operation) =>
    operation.questions.flatMap((question) =>
      duplicateValues(question.choices.map(({ id }) => id)).map((id) =>
        diagnostic(
          "duplicate-id",
          "malformed",
          `Question ${question.id} has duplicate choice id ${id}`,
          location("choice", { operation: operation.id, question: question.id, choice: id }),
        ),
      ),
    ),
  );
  return [
    ...duplicateOperations.map((id) =>
      diagnostic(
        "duplicate-id",
        "malformed",
        `Duplicate Operation id ${id}`,
        location("operation", { operation: id }),
      ),
    ),
    ...duplicateTriggers.map((id) =>
      diagnostic(
        "duplicate-id",
        "malformed",
        `Duplicate Trigger id ${id}`,
        location("trigger", { trigger: id }),
      ),
    ),
    ...duplicateQuestions,
    ...duplicateChoices,
  ];
};

const duplicateTransitionDiagnostics = (document: WorkflowDocument) =>
  document.operations.flatMap((operation) => {
    const keys = operation.transitions.map(transitionKey);
    return duplicateValues(keys).map((key) =>
      diagnostic(
        "duplicate-transition",
        "malformed",
        `Operation ${operation.id} has duplicate Transition ${key}`,
        location("transition", { operation: operation.id }),
      ),
    );
  });

const referenceDiagnostics = (document: WorkflowDocument) => {
  const operationIds = new Set(document.operations.map(({ id }) => id));
  const triggerDiagnostics = document.triggers.flatMap((trigger) =>
    operationIds.has(trigger.start)
      ? []
      : [
          diagnostic(
            "unknown-reference",
            "malformed",
            `Trigger ${trigger.id} starts missing Operation ${trigger.start}`,
            location("start", { trigger: trigger.id }),
          ),
        ],
  );
  const transitionDiagnostics = document.operations.flatMap((operation) => {
    const questions = new Map(operation.questions.map((question) => [question.id, question]));
    return operation.transitions.flatMap((transition) => {
      const handOff =
        transition.handOff !== null && !operationIds.has(transition.handOff)
          ? [
              diagnostic(
                "unknown-reference",
                "malformed",
                `Operation ${operation.id} hands off to missing Operation ${transition.handOff}`,
                location("handOff", { operation: operation.id }),
              ),
            ]
          : [];
      const answers = transition.when.flatMap(({ question, choice }) => {
        const referencedQuestion = questions.get(question);
        if (!referencedQuestion) {
          return [
            diagnostic(
              "unknown-reference",
              "malformed",
              `Transition names missing Question ${question}`,
              location("when", { operation: operation.id, question }),
            ),
          ];
        }
        return referencedQuestion.choices.some(({ id }) => id === choice)
          ? []
          : [
              diagnostic(
                "unknown-reference",
                "malformed",
                `Transition names missing Choice ${choice}`,
                location("when", { operation: operation.id, question, choice }),
              ),
            ];
      });
      return [...handOff, ...answers];
    });
  });
  return [...triggerDiagnostics, ...transitionDiagnostics];
};

const selfHandOffDiagnostics = (document: WorkflowDocument) =>
  document.operations.flatMap((operation) =>
    operation.transitions.flatMap((transition) =>
      transition.handOff === operation.id
        ? [
            diagnostic(
              "self-hand-off",
              "malformed",
              `Operation ${operation.id} hands off to itself`,
              location("handOff", { operation: operation.id }),
            ),
          ]
        : [],
    ),
  );

const entryUsages = (document: WorkflowDocument) => [
  ...document.triggers.map((trigger) => ({
    entry: trigger.entry,
    parameters: trigger.parameters,
    expectedKind: "trigger" as const,
    location: location("entry", { trigger: trigger.id }),
  })),
  ...document.operations.flatMap((operation) =>
    operation.transitions.flatMap((transition) =>
      transition.actions.map((action) => ({
        entry: action.entry,
        parameters: action.parameters,
        expectedKind: "action" as const,
        location: location("entry", { operation: operation.id }),
      })),
    ),
  ),
];

const catalogDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  const usageDiagnostics = entryUsages(document).flatMap((usage) => {
    const entry = entries.get(usage.entry);
    if (!entry || entry.kind !== usage.expectedKind) {
      return [
        diagnostic(
          "unknown-catalog-entry",
          "malformed",
          `Unknown ${usage.expectedKind} catalog entry ${usage.entry}`,
          usage.location,
        ),
      ];
    }
    const unknownParameters = usage.parameters
      .filter(({ id }) => !entry.parameters.some((parameter) => parameter.id === id))
      .map(({ id }) => diagnostic("unknown-option", "malformed", `Unknown parameter ${id}`, usage.location));
    const parameters = new Map(usage.parameters.map((parameter) => [parameter.id, parameter.value]));
    const parameterDiagnostics = entry.parameters.flatMap((parameter) => {
      const value = parameters.get(parameter.id);
      const invalidParameter = {
        fixed: { code: "unknown-option", class: "malformed" },
        live: { code: "option-not-listed", class: "advisory" },
      } as const;
      const result = [
        {
          matches: parameter.required && value === undefined,
          make: () =>
            diagnostic("missing-option", "incomplete", `Missing parameter ${parameter.id}`, usage.location),
        },
        {
          matches: value !== undefined && !parameter.values.includes(value),
          make: () => {
            const invalid = invalidParameter[parameter.source];
            return diagnostic(
              invalid.code,
              invalid.class,
              `Parameter ${parameter.id} does not list ${value}`,
              usage.location,
            );
          },
        },
      ].find(({ matches }) => matches);
      return result ? [result.make()] : [];
    });
    return [...unknownParameters, ...parameterDiagnostics];
  });
  const instructionDiagnostics = document.operations.flatMap((operation) =>
    operation.instructionPackage !== null &&
    !catalog.instructionPackages.includes(operation.instructionPackage)
      ? [
          diagnostic(
            "unknown-option",
            "malformed",
            `Unknown instruction package ${operation.instructionPackage}`,
            location("instructionPackage", { operation: operation.id }),
          ),
        ]
      : [],
  );
  return [...usageDiagnostics, ...instructionDiagnostics];
};

const modelDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) =>
  document.operations.flatMap((operation) => {
    const harnessName = operation.model.harness ?? catalog.defaultHarness;
    const harness = catalog.models.find((candidate) => candidate.harness === harnessName);
    const availability =
      harness?.available === false
        ? [
            diagnostic(
              "harness-unavailable",
              "advisory",
              `Harness ${harnessName} is unavailable`,
              location("model", { operation: operation.id }),
            ),
          ]
        : [];
    const model = harness?.models.find((candidate) => candidate.id === operation.model.model);
    const invalidModel = operation.model.model !== null && (!harness || !model);
    const invalidOptions = operation.model.options.some((option) => {
      const catalogOption = model?.options.find((candidate) => candidate.id === option.id);
      return !catalogOption?.values.includes(option.value);
    });
    const unknownModel = diagnostic(
      "unknown-model",
      "malformed",
      `Unknown model selection for Operation ${operation.id}`,
      location("model", { operation: operation.id }),
    );
    const noHarness = diagnostic(
      "no-harness",
      "advisory",
      `Operation ${operation.id} has no Harness`,
      location("model", { operation: operation.id }),
    );
    return (
      [
        {
          matches:
            harnessName === null && (operation.model.model !== null || operation.model.options.length > 0),
          diagnostics: [unknownModel],
        },
        { matches: harnessName === null, diagnostics: [noHarness] },
        {
          matches: invalidModel || invalidOptions,
          diagnostics: [...availability, unknownModel],
        },
        { matches: operation.model.model === null, diagnostics: availability },
        { matches: true, diagnostics: availability },
      ].find(({ matches }) => matches)?.diagnostics ?? availability
    );
  });

const noTriggerDiagnostics = (document: WorkflowDocument) =>
  document.triggers.length === 0
    ? [diagnostic("no-trigger", "incomplete", "Workflow has no Trigger", location("triggers"))]
    : [];

const uncoveredDiagnostics = (document: WorkflowDocument) =>
  document.operations.flatMap((operation) =>
    uncovered(operation).length > 0
      ? [
          diagnostic(
            "uncovered-outcome",
            "incomplete",
            `Operation ${operation.id} has uncovered answers`,
            location("transitions", { operation: operation.id }),
          ),
        ]
      : [],
  );

const conflictingHandOffDiagnostics = (document: WorkflowDocument) =>
  document.operations.flatMap((operation) =>
    answerCombinations(operation).flatMap((answers) => {
      const handOffs = new Set(
        operation.transitions
          .filter((transition) => transitionMatches(transition, answers))
          .flatMap((transition) => (transition.handOff === null ? [] : [transition.handOff])),
      );
      return handOffs.size > 1
        ? [
            diagnostic(
              "conflicting-hand-offs",
              "incomplete",
              `Operation ${operation.id} has conflicting hand-offs`,
              location("handOff", { operation: operation.id }),
            ),
          ]
        : [];
    }),
  );

const emptyInstructionDiagnostics = (document: WorkflowDocument) =>
  document.operations.flatMap((operation) =>
    operation.instructionPackage === null && operation.instruction.trim().length === 0
      ? [
          diagnostic(
            "empty-instruction",
            "incomplete",
            `Operation ${operation.id} has no instruction`,
            location("instruction", { operation: operation.id }),
          ),
        ]
      : [],
  );

const actionEntries = (operation: WorkflowOperation, catalog: WorkflowCatalog) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  return operation.transitions.flatMap((transition) =>
    transition.actions.flatMap((action) => {
      const entry = entries.get(action.entry);
      return entry?.kind === "action" ? [entry] : [];
    }),
  );
};

const operationCapabilityDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) =>
  document.operations.flatMap((operation) => {
    const entries = actionEntries(operation, catalog);
    const profile =
      entries.some(({ permissionProfile }) => permissionProfile === "full") &&
      operation.permissionProfile === "read-only"
        ? [
            diagnostic(
              "profile-too-narrow",
              "incomplete",
              `Operation ${operation.id} needs the full permission profile`,
              location("permissionProfile", { operation: operation.id }),
            ),
          ]
        : [];
    const noWorkspace = document.workspaces._tag === "Listed" && document.workspaces.workspaces.length === 0;
    const workspace =
      noWorkspace && entries.some(({ requiresWorkspace }) => requiresWorkspace)
        ? [
            diagnostic(
              "no-workspace",
              "incomplete",
              `Operation ${operation.id} needs a Workspace`,
              location("workspaces", { operation: operation.id }),
            ),
          ]
        : [];
    return [...profile, ...workspace];
  });

const reachableKinds = (document: WorkflowDocument, catalog: WorkflowCatalog) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  const seeds = document.triggers.flatMap((trigger) => {
    const kind = entries.get(trigger.entry)?.itemKind;
    return kind === null || kind === undefined ? [] : [[trigger.start, kind] as const];
  });
  const next = (known: ReadonlyArray<readonly [WorkflowNodeId, string]>) => {
    const additions = known.flatMap(([operationId, kind]) =>
      document.operations
        .filter(({ id }) => id === operationId)
        .flatMap((operation) =>
          operation.transitions.flatMap(({ handOff }) =>
            handOff === null ? [] : [[handOff, kind] as const],
          ),
        ),
    );
    return [...known, ...additions].filter(
      (entry, index, values) =>
        values.findIndex(([operationId, kind]) => operationId === entry[0] && kind === entry[1]) === index,
    );
  };
  return Array.from({ length: document.operations.length }, () => null).reduce(next, seeds);
};

const itemKindDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) => {
  const kinds = reachableKinds(document, catalog);
  return document.operations.flatMap((operation) => {
    const operationKinds = kinds.filter(([id]) => id === operation.id).map(([, kind]) => kind);
    const entries = actionEntries(operation, catalog);
    const mismatch = entries.some(
      ({ actsOn }) => !actsOn.includes("*") && operationKinds.some((kind) => !actsOn.includes(kind)),
    );
    return mismatch
      ? [
          diagnostic(
            "item-kind-mismatch",
            "incomplete",
            `Operation ${operation.id} has an action that cannot act on its item kind`,
            location("actions", { operation: operation.id }),
          ),
        ]
      : [];
  });
};

const readinessDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  const connections = entryUsages(document).flatMap((usage) => {
    const entry = entries.get(usage.entry);
    return entry?.connection !== null &&
      entry?.connection !== undefined &&
      !catalog.readyConnections.includes(entry.connection)
      ? [
          diagnostic(
            "connection-not-ready",
            "advisory",
            `Connection ${entry.connection} is not ready`,
            usage.location,
          ),
        ]
      : [];
  });
  const needs = document.operations.flatMap((operation) =>
    operation.requires.flatMap((need) =>
      catalog.readyNeeds.includes(need)
        ? []
        : [
            diagnostic(
              "need-not-ready",
              "advisory",
              `Need ${need} is not ready`,
              location("requires", { operation: operation.id }),
            ),
          ],
    ),
  );
  return [...connections, ...needs];
};

const workspaceDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) => {
  const selected = document.workspaces._tag === "Listed" ? document.workspaces.workspaces : [];
  const registered = selected.flatMap((workspace) =>
    catalog.registeredWorkspaces.includes(workspace)
      ? []
      : [
          diagnostic(
            "workspace-not-registered",
            "advisory",
            `Workspace ${workspace} is not registered`,
            location("workspaces"),
          ),
        ],
  );
  const bindings = entryUsages(document).flatMap((usage) => {
    const system = catalog.entries.find(({ key }) => key === usage.entry)?.system;
    if (system === null || system === undefined) return [];
    const bound = catalog.systemBindings.find((binding) => binding.system === system)?.workspaces ?? [];
    const hasBinding =
      document.workspaces._tag === "Every"
        ? bound.length > 0
        : selected.some((workspace) => bound.includes(workspace));
    return hasBinding
      ? []
      : [diagnostic("system-unbound", "advisory", `No selected Workspace binds ${system}`, usage.location)];
  });
  return [...registered, ...bindings];
};

const unreachableDiagnostics = (document: WorkflowDocument) => {
  const reached = new Set([
    ...document.triggers.map(({ start }) => start),
    ...document.operations.flatMap((operation) =>
      operation.transitions.flatMap(({ handOff }) => (handOff === null ? [] : [handOff])),
    ),
  ]);
  return document.operations.flatMap((operation) =>
    reached.has(operation.id)
      ? []
      : [
          diagnostic(
            "unreachable-operation",
            "advisory",
            `Operation ${operation.id} is unreachable`,
            location("operation", { operation: operation.id }),
          ),
        ],
  );
};

const handOffTriggerDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  const startsByEntry = new Map(document.triggers.map((trigger) => [trigger.entry, trigger.start]));
  return document.operations.flatMap((operation) =>
    operation.transitions.flatMap((transition) => {
      if (transition.handOff === null) return [];
      const emitsHandOffTrigger = transition.actions.some((action) =>
        (entries.get(action.entry)?.emits ?? []).some(
          (entry) => startsByEntry.get(entry) === transition.handOff,
        ),
      );
      return emitsHandOffTrigger
        ? [
            diagnostic(
              "hand-off-and-trigger",
              "advisory",
              `Operation ${operation.id} hands off and also triggers ${transition.handOff}`,
              location("transition", { operation: operation.id }),
            ),
          ]
        : [];
    }),
  );
};

const validationRules = [
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => duplicateIdDiagnostics(document),
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => duplicateTransitionDiagnostics(document),
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => referenceDiagnostics(document),
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => selfHandOffDiagnostics(document),
  catalogDiagnostics,
  modelDiagnostics,
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => noTriggerDiagnostics(document),
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => uncoveredDiagnostics(document),
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => conflictingHandOffDiagnostics(document),
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => emptyInstructionDiagnostics(document),
  operationCapabilityDiagnostics,
  itemKindDiagnostics,
  readinessDiagnostics,
  workspaceDiagnostics,
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => unreachableDiagnostics(document),
  handOffTriggerDiagnostics,
] satisfies ReadonlyArray<
  (document: WorkflowDocument, catalog: WorkflowCatalog) => ReadonlyArray<WorkflowDiagnostic>
>;

export const validateWorkflow = (document: WorkflowDocument, catalog: WorkflowCatalog) =>
  validationRules.flatMap((rule) => rule(document, catalog));

export const validateWorkflowInput = (input: unknown, catalog: WorkflowCatalog) => {
  const decoded = Schema.decodeUnknownExit(WorkflowDocument, {
    errors: "all",
    onExcessProperty: "error",
  })(input);
  if (Exit.isFailure(decoded)) {
    return [diagnostic("schema", "malformed", Cause.pretty(decoded.cause), location("document"))];
  }
  return validateWorkflow(decoded.value, catalog);
};
