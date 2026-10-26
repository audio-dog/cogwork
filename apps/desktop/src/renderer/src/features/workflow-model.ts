import type { HarnessName } from "@cogwork/contracts";
import { type CatalogChoice, choiceKey, type InputSource, sameChoice } from "./workflow-catalog";

export interface Choice {
  readonly id: string;
  readonly name: string;
}

export interface Question {
  readonly id: string;
  /** The property the agent's answer is returned under in the structured output. */
  readonly key: string;
  readonly text: string;
  readonly choices: readonly Choice[];
}

/** Question id → choice id. */
export type Condition = Readonly<Record<string, string>>;

export interface Route {
  readonly when: Condition;
  readonly steps: readonly CatalogChoice[];
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
  /** Keyed by `choiceKey` then input id, so a step on several routes shares one setting. */
  readonly inputs: Readonly<Record<string, Readonly<Record<string, InputSource>>>>;
}

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly workspaces: readonly string[];
  readonly triggers: readonly CatalogChoice[];
  readonly operations: readonly Operation[];
  readonly waiting: number;
}

/** In question order, not insertion order, so equal conditions always share a key. */
export const conditionKey = (operation: Operation, when: Condition) =>
  operation.questions
    .filter((question) => when[question.id] !== undefined)
    .map((question) => `${question.id}=${when[question.id]}`)
    .join("&");

const sameCondition = (operation: Operation, a: Condition, b: Condition) =>
  conditionKey(operation, a) === conditionKey(operation, b);

const isEvery = (when: Condition) => Object.keys(when).length === 0;

const choiceName = (operation: Operation, questionId: string, choiceId: string) =>
  operation.questions
    .find((question) => question.id === questionId)
    ?.choices.find((choice) => choice.id === choiceId)?.name ?? choiceId;

export const conditionParts = (operation: Operation, when: Condition) =>
  operation.questions
    .filter((question) => when[question.id] !== undefined)
    .map((question) => ({
      questionId: question.id,
      key: question.key,
      choice: choiceName(operation, question.id, when[question.id] ?? ""),
    }));

type ConditionPart = ReturnType<typeof conditionParts>[number];

export const conditionLabel = (operation: Operation, when: Condition) => {
  if (isEvery(when)) return "Every time";
  const label =
    operation.questions.length === 1
      ? (part: ConditionPart) => part.choice
      : (part: ConditionPart) => `${part.key}: ${part.choice}`;
  return conditionParts(operation, when).map(label).join(" · ");
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

export const stepsAt = (operation: Operation, when: Condition) => routeAt(operation, when)?.steps ?? [];

const stepsFor = (operation: Operation, answers: Condition) =>
  operation.routes
    .filter((route) => matches(route.when, answers))
    .flatMap((route) => route.steps.map((step) => ({ step, from: route.when })));

export const uncovered = (operation: Operation) =>
  combinations(operation.questions).filter((answers) => stepsFor(operation, answers).length === 0);

export const combinedRoutes = (operation: Operation) =>
  operation.routes.filter((route) => Object.keys(route.when).length > 1);

export const agentInputs = (operation: Operation, step: CatalogChoice) =>
  step.inputs.flatMap((entry) => {
    const source = operation.inputs[choiceKey(step)]?.[entry.id] ?? entry.source;
    return source.kind === "agent" ? [{ entry, source }] : [];
  });

const withRoute = (
  operation: Operation,
  when: Condition,
  change: (steps: readonly CatalogChoice[]) => readonly CatalogChoice[],
) => {
  const existing = routeAt(operation, when);
  if (!existing) return { ...operation, routes: [...operation.routes, { when, steps: change([]) }] };
  return {
    ...operation,
    routes: operation.routes.map((route) =>
      route === existing ? { ...route, steps: change(route.steps) } : route,
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
  key: id,
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
  inputs: {},
});

export const operationEdits = {
  rename: (operation: Operation, name: string) => ({ ...operation, name }),
  instruct: (operation: Operation, instruction: string) => ({ ...operation, instruction }),
  chooseModel: (operation: Operation, model: ModelChoice) => ({ ...operation, model }),
  addStep: (operation: Operation, when: Condition, step: CatalogChoice) =>
    withRoute(operation, when, (steps) =>
      steps.some((existing) => sameChoice(existing, step)) ? steps : [...steps, step],
    ),
  removeStep: (operation: Operation, when: Condition, step: CatalogChoice) =>
    withRoute(operation, when, (steps) => steps.filter((existing) => !sameChoice(existing, step))),
  addRoute: (operation: Operation, when: Condition) => withRoute(operation, when, (steps) => steps),
  removeRoute: (operation: Operation, when: Condition) => ({
    ...operation,
    routes: operation.routes.filter((route) => !sameCondition(operation, route.when, when)),
  }),
  setInput: (operation: Operation, step: CatalogChoice, inputId: string, source: InputSource) => {
    const key = choiceKey(step);
    return {
      ...operation,
      inputs: { ...operation.inputs, [key]: { ...operation.inputs[key], [inputId]: source } },
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
