import type { HarnessName } from "@cogwork/contracts";
import { type AgentInput, type CatalogChoice, choiceKey, sameChoice } from "./workflow-catalog";

export interface Choice {
  readonly id: string;
  readonly name: string;
}

export interface Question {
  readonly id: string;
  readonly text: string;
  readonly choices: readonly Choice[];
}

export type Condition = Readonly<Record<Question["id"], Choice["id"]>>;

export interface Route {
  readonly when: Condition;
  readonly actions: readonly CatalogChoice[];
}

/** Null leaves the choice to the Operation settings. */
export interface ModelChoice {
  readonly harness: HarnessName | null;
  readonly model: string | null;
}

export interface Operation {
  readonly id: string;
  readonly name: string;
  readonly instruction: string;
  readonly model: ModelChoice;
  readonly questions: readonly Question[];
  readonly routes: readonly Route[];
  /** Keyed by `choiceKey` then input id, so an Action on several routes shares one hint. */
  readonly hints: Readonly<Record<string, Readonly<Record<AgentInput["id"], string>>>>;
}

export type WorkspaceScope =
  | { readonly kind: "every" }
  | { readonly kind: "listed"; readonly names: readonly string[] };

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly workspaces: WorkspaceScope;
  readonly triggers: readonly CatalogChoice[];
  readonly operations: readonly Operation[];
}

export const conditionKey = (operation: Operation, when: Condition) =>
  operation.questions
    .filter((question) => when[question.id] !== undefined)
    .map((question) => `${question.id}=${when[question.id]}`)
    .join("&");

const sameCondition = (operation: Operation, a: Condition, b: Condition) =>
  conditionKey(operation, a) === conditionKey(operation, b);

const isEvery = (when: Condition) => Object.keys(when).length === 0;

export const namesQuestions = (operation: Operation) => operation.questions.length > 1;

const choiceName = (operation: Operation, questionId: string, choiceId: string) =>
  operation.questions
    .find((question) => question.id === questionId)
    ?.choices.find((choice) => choice.id === choiceId)?.name ?? choiceId;

export const conditionParts = (operation: Operation, when: Condition) =>
  operation.questions
    .filter((question) => when[question.id] !== undefined)
    .map((question) => ({
      questionId: question.id,
      choice: choiceName(operation, question.id, when[question.id] ?? ""),
    }));

export const conditionLabel = (operation: Operation, when: Condition) => {
  if (isEvery(when)) return "Every time";
  return conditionParts(operation, when)
    .map((part) => (namesQuestions(operation) ? `${part.questionId}: ${part.choice}` : part.choice))
    .join(" · ");
};

const combinations = (questions: readonly Question[]) =>
  questions.reduce<readonly Condition[]>(
    (partial, next) =>
      partial.flatMap((when) => next.choices.map((choice) => ({ ...when, [next.id]: choice.id }))),
    [{}],
  );

const matches = (when: Condition, answers: Condition) =>
  Object.entries(when).every(([questionId, choiceId]) => answers[questionId] === choiceId);

export const routeAt = (operation: Operation, when: Condition) =>
  operation.routes.find((route) => sameCondition(operation, route.when, when));

export const actionsAt = (operation: Operation, when: Condition) => routeAt(operation, when)?.actions ?? [];

export const uncovered = (operation: Operation) =>
  combinations(operation.questions).filter(
    (answers) => !operation.routes.some((route) => matches(route.when, answers) && route.actions.length > 0),
  );

export const combinedRoutes = (operation: Operation) =>
  operation.routes.filter((route) => Object.keys(route.when).length > 1);

export const agentInstructions = (operation: Operation, action: CatalogChoice) =>
  action.agentInputs.map((input) => ({
    input,
    hint: operation.hints[choiceKey(action)]?.[input.id] ?? input.hint,
  }));

const withRoute = (
  operation: Operation,
  when: Condition,
  change: (actions: readonly CatalogChoice[]) => readonly CatalogChoice[],
) => {
  const existing = routeAt(operation, when);
  if (!existing) return { ...operation, routes: [...operation.routes, { when, actions: change([]) }] };
  return {
    ...operation,
    routes: operation.routes.map((route) =>
      route === existing ? { ...route, actions: change(route.actions) } : route,
    ),
  };
};

const mapQuestion = (operation: Operation, questionId: string, change: (question: Question) => Question) => ({
  ...operation,
  questions: operation.questions.map((question) =>
    question.id === questionId ? change(question) : question,
  ),
});

const freshId = (prefix: string, taken: readonly string[]) =>
  Array.from({ length: taken.length + 1 }, (_, index) => `${prefix}-${index + 1}`).find(
    (id) => !taken.includes(id),
  ) ?? `${prefix}-${taken.length + 1}`;

const yesOrNo = (id: string) => ({
  id,
  text: "",
  choices: [
    { id: "yes", name: "yes" },
    { id: "no", name: "no" },
  ],
});

export const blankOperation = (taken: readonly string[]) => ({
  id: freshId("operation", taken),
  name: "New Operation",
  instruction: "",
  model: { harness: null, model: null },
  questions: [yesOrNo("outcome")],
  routes: [],
  hints: {},
});

export const operationEdits = {
  rename: (operation: Operation, name: string) => ({ ...operation, name }),
  instruct: (operation: Operation, instruction: string) => ({ ...operation, instruction }),
  chooseModel: (operation: Operation, model: ModelChoice) => ({ ...operation, model }),
  addAction: (operation: Operation, when: Condition, action: CatalogChoice) =>
    withRoute(operation, when, (actions) =>
      actions.some((existing) => sameChoice(existing, action)) ? actions : [...actions, action],
    ),
  removeAction: (operation: Operation, when: Condition, action: CatalogChoice) =>
    withRoute(operation, when, (actions) => actions.filter((existing) => !sameChoice(existing, action))),
  addRoute: (operation: Operation, when: Condition) => withRoute(operation, when, (actions) => actions),
  removeRoute: (operation: Operation, when: Condition) => ({
    ...operation,
    routes: operation.routes.filter((route) => !sameCondition(operation, route.when, when)),
  }),
  setHint: (operation: Operation, action: CatalogChoice, inputId: string, hint: string) => {
    const key = choiceKey(action);
    return {
      ...operation,
      hints: { ...operation.hints, [key]: { ...operation.hints[key], [inputId]: hint } },
    };
  },
  setQuestionText: (operation: Operation, questionId: string, text: string) =>
    mapQuestion(operation, questionId, (question) => ({ ...question, text })),
  renameChoice: (operation: Operation, questionId: string, choiceId: string, name: string) =>
    mapQuestion(operation, questionId, (question) => ({
      ...question,
      choices: question.choices.map((choice) => (choice.id === choiceId ? { ...choice, name } : choice)),
    })),
  addChoice: (operation: Operation, questionId: string) =>
    mapQuestion(operation, questionId, (question) => {
      const id = freshId(
        "outcome",
        question.choices.map((choice) => choice.id),
      );
      return { ...question, choices: [...question.choices, { id, name: id }] };
    }),
  removeChoice: (operation: Operation, questionId: string, choiceId: string) => ({
    ...mapQuestion(operation, questionId, (question) => ({
      ...question,
      choices: question.choices.filter((choice) => choice.id !== choiceId),
    })),
    routes: operation.routes.filter((route) => route.when[questionId] !== choiceId),
  }),
  addQuestion: (operation: Operation) => ({
    ...operation,
    questions: [
      ...operation.questions,
      yesOrNo(
        freshId(
          "question",
          operation.questions.map((question) => question.id),
        ),
      ),
    ],
  }),
  removeQuestion: (operation: Operation, questionId: string) => ({
    ...operation,
    questions: operation.questions.filter((question) => question.id !== questionId),
    routes: operation.routes.filter((route) => route.when[questionId] === undefined),
  }),
};
