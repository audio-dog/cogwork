import type {
  WorkflowAction,
  WorkflowCatalogEntry,
  WorkflowEdit,
  WorkflowNodeId,
  WorkflowOperation,
  WorkflowTransition,
  WorkflowTransitionAnswer,
} from "@cogwork/contracts";

export type Answers = ReadonlyArray<WorkflowTransitionAnswer>;

export const answersKey = (when: Answers) =>
  when
    .map(({ question, choice }) => `${question}=${choice}`)
    .sort()
    .join("&");

export const transitionAt = (operation: WorkflowOperation, when: Answers) =>
  operation.transitions.find((transition) => answersKey(transition.when) === answersKey(when));

const sameAction = (a: WorkflowAction, b: WorkflowAction) =>
  a.entry === b.entry && JSON.stringify(a.parameters) === JSON.stringify(b.parameters);

const requiredProfile = (
  transitions: ReadonlyArray<WorkflowTransition>,
  entries: ReadonlyArray<WorkflowCatalogEntry>,
): WorkflowOperation["permissionProfile"] =>
  transitions.some(({ actions }) =>
    actions.some(({ entry }) => entries.find(({ key }) => key === entry)?.permissionProfile === "full"),
  )
    ? "full"
    : "read-only";

const ensureTransition = (operation: WorkflowOperation, when: Answers): ReadonlyArray<WorkflowEdit> =>
  transitionAt(operation, when) ? [] : [{ _tag: "AddTransition", operation: operation.id, when }];

/**
 * The permission profile follows the actions: an Operation is `full` exactly when one of its
 * actions needs it, so `profile-too-narrow` never needs a control of its own.
 */
const withActions = (
  operation: WorkflowOperation,
  when: Answers,
  actions: ReadonlyArray<WorkflowAction>,
  entries: ReadonlyArray<WorkflowCatalogEntry>,
): ReadonlyArray<WorkflowEdit> => {
  const key = answersKey(when);
  const others = operation.transitions.filter((transition) => answersKey(transition.when) !== key);
  const profile = requiredProfile([...others, { when, actions, handOff: null }], entries);
  return [
    ...ensureTransition(operation, when),
    { _tag: "SetTransitionActions", operation: operation.id, when, actions },
    ...(profile === operation.permissionProfile
      ? []
      : [{ _tag: "SetPermissionProfile" as const, operation: operation.id, profile }]),
  ];
};

const actionsAt = (operation: WorkflowOperation, when: Answers) =>
  transitionAt(operation, when)?.actions ?? [];

export const outcomeEdits = {
  addAction: (
    operation: WorkflowOperation,
    when: Answers,
    action: WorkflowAction,
    entries: ReadonlyArray<WorkflowCatalogEntry>,
  ) => {
    const current = actionsAt(operation, when);
    if (current.some((existing) => sameAction(existing, action))) return [];
    return withActions(operation, when, [...current, action], entries);
  },
  removeAction: (
    operation: WorkflowOperation,
    when: Answers,
    index: number,
    entries: ReadonlyArray<WorkflowCatalogEntry>,
  ) =>
    withActions(
      operation,
      when,
      actionsAt(operation, when).filter((_, at) => at !== index),
      entries,
    ),
  setActionParameter: (
    operation: WorkflowOperation,
    when: Answers,
    index: number,
    parameter: string,
    value: string,
    entries: ReadonlyArray<WorkflowCatalogEntry>,
  ) =>
    withActions(
      operation,
      when,
      actionsAt(operation, when).map((action, at) =>
        at === index
          ? {
              ...action,
              parameters: [
                ...action.parameters.filter(({ id }) => id !== parameter),
                { id: parameter, value },
              ],
            }
          : action,
      ),
      entries,
    ),
  handOff: (
    operation: WorkflowOperation,
    when: Answers,
    handOff: WorkflowNodeId | null,
  ): ReadonlyArray<WorkflowEdit> => [
    ...ensureTransition(operation, when),
    { _tag: "SetTransitionHandOff", operation: operation.id, when, handOff },
  ],
};
