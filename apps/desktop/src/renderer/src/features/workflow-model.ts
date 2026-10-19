import { useState } from "react";
import { type CatalogChoice, choiceKey, type InputSource, inputsFor } from "./workflow-catalog";

/**
 * What an Operation decides, and what Cogwork does with each decision.
 *
 * An Operation asks one or more questions. The agent answers each with exactly one of its choices,
 * constrained by the Operation's structured output. A route names a choice for some of the
 * questions and leaves the rest open, and **every route whose choices match the answers runs**: a
 * route that names nothing runs every time, and a broad route ("request is no") never competes with
 * a narrow one ("request is yes and match is new"). There is no order and no fallback, so a
 * combination no route reaches does nothing, and the editor says so.
 *
 * A step is an Action from the catalog, or a hand-off that starts another Operation of the same
 * Workflow. One route holds any number of steps.
 */

export interface Choice {
  readonly id: string;
  readonly name: string;
}

export interface Question {
  readonly id: string;
  /** The property the agent's answer is returned under. */
  readonly key: string;
  readonly text: string;
  readonly choices: readonly Choice[];
}

/** Question id → choice id. A question it does not name is open. */
export type Condition = Readonly<Record<string, string>>;

export interface Route {
  readonly when: Condition;
  readonly steps: readonly CatalogChoice[];
}

export interface Operation {
  readonly id: string;
  readonly name: string;
  readonly instruction: string;
  readonly questions: readonly Question[];
  readonly routes: readonly Route[];
  /**
   * Input sources changed from the catalog's defaults, keyed by step then input. A step used on
   * several routes shares one setting, so the same comment on two outcomes is one field.
   */
  readonly inputs: Readonly<Record<string, Readonly<Record<string, InputSource>>>>;
}

export interface WorkflowActivity {
  readonly runsLastWeek: number;
  readonly lastRun: string;
  /** Items parked on a human touchpoint. */
  readonly waiting: number;
}

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly origin: "cogwork" | "yours";
  readonly enabled: boolean;
  readonly workspaces: readonly string[];
  readonly triggers: readonly CatalogChoice[];
  readonly operations: readonly Operation[];
  readonly activity: WorkflowActivity;
}

/* ---------- reading the model ---------- */

/** Keys a condition by question order, so the same choices always produce the same key. */
export const conditionKey = (operation: Operation, when: Condition) =>
  operation.questions
    .filter((question) => when[question.id] !== undefined)
    .map((question) => `${question.id}=${when[question.id]}`)
    .join("&");

const isEvery = (when: Condition) => Object.keys(when).length === 0;

export const isComplete = (operation: Operation, when: Condition) =>
  Object.keys(when).length === operation.questions.length;

const choiceName = (operation: Operation, questionId: string, choiceId: string) =>
  operation.questions
    .find((question) => question.id === questionId)
    ?.choices.find((choice) => choice.id === choiceId)?.name ?? choiceId;

/** The named parts of a condition in question order. */
export const conditionParts = (operation: Operation, when: Condition) =>
  operation.questions
    .filter((question) => when[question.id] !== undefined)
    .map((question) => ({
      questionId: question.id,
      key: question.key,
      choice: choiceName(operation, question.id, when[question.id] ?? ""),
    }));

/** Short text for a condition: the choice alone for one question, `key: choice` pairs for several. */
export const conditionLabel = (operation: Operation, when: Condition) => {
  if (isEvery(when)) return "Every time";
  const parts = conditionParts(operation, when);
  if (operation.questions.length === 1) return parts.map((part) => part.choice).join(" · ");
  return parts.map((part) => `${part.key}: ${part.choice}`).join(" · ");
};

/** Every full combination of answers the agent can return. */
const combinations = (questions: readonly Question[]): readonly Condition[] =>
  questions.reduce<readonly Condition[]>(
    (partial, next) =>
      partial.flatMap((when) => next.choices.map((choice) => ({ ...when, [next.id]: choice.id }))),
    [{}],
  );

const matches = (when: Condition, answers: Condition) =>
  Object.entries(when).every(([questionId, choiceId]) => answers[questionId] === choiceId);

export const routeAt = (operation: Operation, when: Condition) =>
  operation.routes.find((route) => conditionKey(operation, route.when) === conditionKey(operation, when));

export const stepsAt = (operation: Operation, when: Condition) => routeAt(operation, when)?.steps ?? [];

/** What runs for one set of answers, each step paired with the route it came from. */
const stepsFor = (operation: Operation, answers: Condition) =>
  operation.routes
    .filter((route) => matches(route.when, answers))
    .flatMap((route) => route.steps.map((step) => ({ step, from: route.when })));

/** Steps a condition also runs from broader routes. */
export const inheritedAt = (operation: Operation, when: Condition) =>
  stepsFor(operation, when).filter(
    ({ from }) => conditionKey(operation, from) !== conditionKey(operation, when),
  );

/** Combinations no route reaches, so nothing happens when the agent answers that way. */
export const uncovered = (operation: Operation) =>
  combinations(operation.questions).filter((answers) => stepsFor(operation, answers).length === 0);

/** Routes that name more than one question. */
export const combinedRoutes = (operation: Operation) =>
  operation.routes.filter((route) => Object.keys(route.when).length > 1);

const inputSource = (operation: Operation, step: CatalogChoice, inputId: string) =>
  operation.inputs[choiceKey(step)]?.[inputId] ??
  inputsFor(step).find((entry) => entry.id === inputId)?.source;

/** The inputs of a step the agent writes, each with the instruction it reads. */
export const agentInputs = (operation: Operation, step: CatalogChoice) =>
  inputsFor(step).flatMap((entry) => {
    const source = inputSource(operation, step, entry.id);
    return source?.kind === "agent" ? [{ entry, source }] : [];
  });

/* ---------- editing the model ---------- */

/** Changes the steps of the route at one condition, and creates the route when it is missing. */
const withRoute = (
  operation: Operation,
  when: Condition,
  change: (steps: readonly CatalogChoice[]) => readonly CatalogChoice[],
): Operation => {
  const existing = routeAt(operation, when);
  if (!existing) return { ...operation, routes: [...operation.routes, { when, steps: change([]) }] };
  return {
    ...operation,
    routes: operation.routes.map((route) =>
      route === existing ? { ...route, steps: change(route.steps) } : route,
    ),
  };
};

const freshId = (prefix: string, taken: readonly string[]) =>
  [...Array(taken.length + 1).keys()]
    .map((index) => `${prefix}-${index + 1}`)
    .find((id) => !taken.includes(id)) ?? `${prefix}-${taken.length + 1}`;

const yesOrNo = (id: string): Question => ({
  id,
  key: id,
  text: "",
  choices: [
    { id: "yes", name: "yes" },
    { id: "no", name: "no" },
  ],
});

export const blankOperation = (taken: readonly string[]): Operation => {
  const id = freshId("operation", taken);
  return {
    id,
    name: "New Operation",
    instruction: "",
    questions: [yesOrNo("outcome")],
    routes: [],
    inputs: {},
  };
};

const mapQuestion = (operation: Operation, questionId: string, change: (question: Question) => Question) => ({
  ...operation,
  questions: operation.questions.map((question) =>
    question.id === questionId ? change(question) : question,
  ),
});

/** One Operation's working copy. Nothing persists: the editor runs on mock data. */
export function useOperationDraft(seed: Operation) {
  const [operation, setOperation] = useState(seed);

  const actions = {
    addStep: (when: Condition, step: CatalogChoice) =>
      setOperation((current) =>
        withRoute(current, when, (steps) =>
          steps.some((existing) => choiceKey(existing) === choiceKey(step)) ? steps : [...steps, step],
        ),
      ),
    removeStep: (when: Condition, step: CatalogChoice) =>
      setOperation((current) =>
        withRoute(current, when, (steps) =>
          steps.filter((existing) => choiceKey(existing) !== choiceKey(step)),
        ),
      ),
    addRoute: (when: Condition) => setOperation((current) => withRoute(current, when, (steps) => steps)),
    removeRoute: (when: Condition) =>
      setOperation((current) => ({
        ...current,
        routes: current.routes.filter(
          (route) => conditionKey(current, route.when) !== conditionKey(current, when),
        ),
      })),
    setInput: (step: CatalogChoice, inputId: string, source: InputSource) =>
      setOperation((current) => {
        const key = choiceKey(step);
        return {
          ...current,
          inputs: { ...current.inputs, [key]: { ...current.inputs[key], [inputId]: source } },
        };
      }),
    setQuestionText: (questionId: string, text: string) =>
      setOperation((current) => mapQuestion(current, questionId, (question) => ({ ...question, text }))),
    renameChoice: (questionId: string, choiceId: string, name: string) =>
      setOperation((current) =>
        mapQuestion(current, questionId, (question) => ({
          ...question,
          choices: question.choices.map((choice) => (choice.id === choiceId ? { ...choice, name } : choice)),
        })),
      ),
    addChoice: (questionId: string) =>
      setOperation((current) =>
        mapQuestion(current, questionId, (question) => {
          const id = freshId(
            "outcome",
            question.choices.map((choice) => choice.id),
          );
          return { ...question, choices: [...question.choices, { id, name: id }] };
        }),
      ),
    removeChoice: (questionId: string, choiceId: string) =>
      setOperation((current) => ({
        ...mapQuestion(current, questionId, (question) => ({
          ...question,
          choices: question.choices.filter((choice) => choice.id !== choiceId),
        })),
        routes: current.routes.filter((route) => route.when[questionId] !== choiceId),
      })),
    addQuestion: () =>
      setOperation((current) => ({
        ...current,
        questions: [
          ...current.questions,
          yesOrNo(
            freshId(
              "question",
              current.questions.map((question) => question.id),
            ),
          ),
        ],
      })),
    removeQuestion: (questionId: string) =>
      setOperation((current) => ({
        ...current,
        questions: current.questions.filter((question) => question.id !== questionId),
        routes: current.routes.filter((route) => route.when[questionId] === undefined),
      })),
  };

  return { operation, actions };
}

export type OperationDraftActions = ReturnType<typeof useOperationDraft>["actions"];
