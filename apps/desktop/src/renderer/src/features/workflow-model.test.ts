import { describe, expect, it } from "vitest";
import { pickAction } from "./workflow-catalog";
import { type Operation, operationEdits, uncovered } from "./workflow-model";

const comment = pickAction("github", "comment");
const close = pickAction("github", "close");
const createIssue = pickAction("github", "create-issue");

const question = (id: string, ...choices: readonly string[]) => ({
  id,
  text: "",
  choices: choices.map((name) => ({ id: name, name })),
});

const operation = (id: string, overrides: Partial<Operation> = {}): Operation => ({
  id,
  name: id,
  instruction: "",
  model: { harness: null, model: null },
  questions: [],
  routes: [],
  hints: {},
  ...overrides,
});

const extract = operation("extract", {
  questions: [question("request", "yes", "no"), question("match", "new", "duplicate")],
  routes: [
    { when: {}, actions: [comment] },
    { when: { request: "no" }, actions: [close] },
    { when: { request: "yes", match: "new" }, actions: [createIssue] },
  ],
});

describe("uncovered", () => {
  it("names only the answers no route reaches", () => {
    const withoutEveryTime = {
      ...extract,
      routes: extract.routes.filter((route) => Object.keys(route.when).length > 0),
    };
    expect(uncovered(withoutEveryTime)).toEqual([{ request: "yes", match: "duplicate" }]);
  });

  it("finds no gap when a route runs every time", () => {
    expect(uncovered(extract)).toEqual([]);
  });
});

describe("operationEdits.removeChoice", () => {
  it("drops every route that names the removed outcome, and keeps the rest", () => {
    const edited = operationEdits.removeChoice(extract, "request", "yes");
    expect(edited.routes.map((route) => route.when)).toEqual([{}, { request: "no" }]);
  });
});
