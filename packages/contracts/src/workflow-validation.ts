import type { WorkflowDocument, WorkflowNodeId, WorkflowOperation } from "./workflow";
import type { WorkflowCatalog, WorkflowCatalogEntry } from "./workflow-catalog";
import {
  decodeWorkflowDocumentValue,
  diagnostic,
  location,
  type WorkflowDiagnostic,
} from "./workflow-diagnostic";
import { answerCombinations, transitionKey, transitionMatches, uncovered } from "./workflow-operation-result";

const duplicateValues = <A extends string>(values: ReadonlyArray<A>) =>
  values
    .filter((value, index) => values.indexOf(value) !== index)
    .filter((value, index, duplicates) => duplicates.indexOf(value) === index);

export const duplicateIdDiagnostics = (document: WorkflowDocument) => {
  const nodes = [
    ...document.operations.map(({ id }) => ({
      id,
      location: location("operation", { operation: id }),
    })),
    ...document.triggers.map(({ id }) => ({
      id,
      location: location("trigger", { trigger: id }),
    })),
    ...document.operations.flatMap((operation) =>
      operation.questions.map(({ id }) => ({
        id,
        location: location("question", { operation: operation.id, question: id }),
      })),
    ),
  ];
  const duplicateNodes = duplicateValues(nodes.map(({ id }) => id)).map((id) =>
    diagnostic(
      "duplicate-id",
      "malformed",
      `Duplicate node id ${id}`,
      nodes.find((node) => node.id === id)?.location,
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
  return [...duplicateNodes, ...duplicateChoices];
};

export const duplicateTransitionDiagnostics = (document: WorkflowDocument) =>
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

export const referenceDiagnostics = (document: WorkflowDocument) => {
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

export const selfHandOffDiagnostics = (document: WorkflowDocument) =>
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

export const entryUsages = (document: WorkflowDocument) => [
  ...document.triggers.map((trigger) => ({
    entry: trigger.entry,
    parameters: trigger.parameters,
    expectedKind: "trigger" as const,
    location: location("entry", { trigger: trigger.id }),
  })),
  ...document.triggers.flatMap((trigger) =>
    trigger.filters.map(({ entry }) => ({
      entry,
      parameters: [],
      expectedKind: "filter" as const,
      location: location("filters", { trigger: trigger.id }),
    })),
  ),
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
    const parameterDiagnostics = entry.parameters.flatMap((parameter) => {
      const values = usage.parameters.filter(({ id }) => id === parameter.id).map(({ value }) => value);
      const result = [
        {
          matches: parameter.required && values.length === 0,
          make: () => [
            diagnostic("missing-option", "incomplete", `Missing parameter ${parameter.id}`, usage.location),
          ],
        },
        {
          matches: parameter.source === "fixed",
          make: () =>
            values
              .filter((value) => !parameter.values.includes(value))
              .map((value) =>
                diagnostic(
                  "unknown-option",
                  "malformed",
                  `Parameter ${parameter.id} does not list ${value}`,
                  usage.location,
                ),
              ),
        },
      ].find(({ matches }) => matches);
      return result?.make() ?? [];
    });
    return [...unknownParameters, ...parameterDiagnostics];
  });
  const instructionDiagnostics = document.operations.flatMap((operation) =>
    operation.instructionPackage !== null &&
    !catalog.instructionPackages.includes(operation.instructionPackage)
      ? [
          diagnostic(
            "unknown-catalog-entry",
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
    const harnessName = operation.model.harness;
    const harness = catalog.harnesses.find((candidate) => candidate.name === harnessName);
    const model = harness?.models.find((candidate) => candidate.id === operation.model.model);
    const invalidHarness = harnessName !== null && !harness;
    const invalidModel = operation.model.model !== null && (!harness || !model);
    const invalidOptions = operation.model.options.some((option) => {
      const catalogOption = model?.options.find((candidate) => candidate.id === option.id);
      return !catalogOption?.values.includes(option.value);
    });
    const invalidImplicitSelection =
      harnessName === null && (operation.model.model !== null || operation.model.options.length > 0);
    const invalidSelection = invalidImplicitSelection || invalidHarness || invalidModel || invalidOptions;
    return invalidSelection
      ? [
          diagnostic(
            "unknown-model",
            "malformed",
            `Unknown model selection for Operation ${operation.id}`,
            location("model", { operation: operation.id }),
          ),
        ]
      : [];
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

interface ReachedItem {
  readonly operation: WorkflowNodeId;
  readonly system: string | null;
  readonly kind: string;
}

const sameReach = (left: ReachedItem, right: ReachedItem) =>
  left.operation === right.operation && left.system === right.system && left.kind === right.kind;

const reachableItems = (document: WorkflowDocument, catalog: WorkflowCatalog) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  const seeds = document.triggers.flatMap((trigger): ReadonlyArray<ReachedItem> => {
    const entry = entries.get(trigger.entry);
    return entry?.itemKind ? [{ operation: trigger.start, system: entry.system, kind: entry.itemKind }] : [];
  });
  const next = (known: ReadonlyArray<ReachedItem>) => {
    const additions = known.flatMap((item) =>
      document.operations
        .filter(({ id }) => id === item.operation)
        .flatMap((operation) =>
          operation.transitions.flatMap(({ handOff }) =>
            handOff === null ? [] : [{ ...item, operation: handOff }],
          ),
        ),
    );
    return [...known, ...additions].filter(
      (item, index, values) => values.findIndex((other) => sameReach(item, other)) === index,
    );
  };
  return Array.from({ length: document.operations.length }, () => null).reduce(next, seeds);
};

const matchesAppLimit = (actsOnValue: string, { system, kind }: ReachedItem) => {
  const [app, limitedKind] = actsOnValue.split(".");
  const appUnknown = system === null;
  return limitedKind === kind && (appUnknown || system === app);
};

const acceptsItem = (actsOn: ReadonlyArray<string>, item: ReachedItem) =>
  actsOn.some((value) => value === "*" || value === item.kind || matchesAppLimit(value, item));

const itemName = ({ system, kind }: ReachedItem) => (system === null ? kind : `${system}.${kind}`);

const itemKindDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) => {
  const reached = reachableItems(document, catalog);
  return document.operations.flatMap((operation) => {
    const operationItems = reached.filter((item) => item.operation === operation.id);
    const actions = new Map(actionEntries(operation, catalog).map((entry) => [entry.key, entry]));
    return Array.from(actions.values()).flatMap(({ key, actsOn }) => {
      const refused = operationItems.find((item) => !acceptsItem(actsOn, item));
      return refused
        ? [
            diagnostic(
              "item-kind-mismatch",
              "incomplete",
              `Action ${key} in Operation ${operation.id} acts only on ${actsOn.join(", ")}, but ${itemName(refused)} reaches it`,
              location("actions", { operation: operation.id }),
            ),
          ]
        : [];
    });
  });
};

export const filterAppliesTo = (filter: WorkflowCatalogEntry, trigger: WorkflowCatalogEntry) =>
  filter.kind === "filter" && filter.system === trigger.system && filter.itemKind === trigger.itemKind;

const filterDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  return document.triggers.flatMap((trigger) => {
    const triggerEntry = entries.get(trigger.entry);
    return trigger.filters.flatMap(({ entry }) => {
      const filterEntry = entries.get(entry);
      const notApplicable =
        triggerEntry?.kind === "trigger" &&
        filterEntry?.kind === "filter" &&
        !filterAppliesTo(filterEntry, triggerEntry);
      return notApplicable
        ? [
            diagnostic(
              "filter-not-applicable",
              "incomplete",
              `Filter ${entry} does not apply to Trigger ${trigger.id}`,
              location("filters", { trigger: trigger.id }),
            ),
          ]
        : [];
    });
  });
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
  return document.operations.flatMap((operation) =>
    operation.transitions.flatMap((transition) => {
      if (transition.handOff === null) return [];
      const emitsHandOffTrigger = transition.actions.some((action) =>
        (entries.get(action.entry)?.emits ?? []).some((entry) =>
          document.triggers.some(
            (trigger) => trigger.entry === entry && trigger.start === transition.handOff,
          ),
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
  filterDiagnostics,
  (document: WorkflowDocument, _catalog: WorkflowCatalog) => unreachableDiagnostics(document),
  handOffTriggerDiagnostics,
] satisfies ReadonlyArray<
  (document: WorkflowDocument, catalog: WorkflowCatalog) => ReadonlyArray<WorkflowDiagnostic>
>;

export const validateWorkflow = (document: WorkflowDocument, catalog: WorkflowCatalog) =>
  validationRules.flatMap((rule) => rule(document, catalog));

export const decodeWorkflowDocument = decodeWorkflowDocumentValue;

export const validateWorkflowInput = (input: unknown, catalog: WorkflowCatalog) => {
  const decoded = decodeWorkflowDocument(input);
  return decoded._tag === "Refused" ? decoded.diagnostics : validateWorkflow(decoded.value, catalog);
};
