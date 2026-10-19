import { describe, expect, it } from "vitest";
import { pickAction } from "./workflow-catalog";
import { inheritedAt, type Operation, uncovered } from "./workflow-model";

const comment = pickAction("github", "comment");
const close = pickAction("github", "close");
const createIssue = pickAction("github", "create-issue");

const question = (key: string, ...choices: readonly string[]) => ({
  id: key,
  key,
  text: "",
  choices: choices.map((name) => ({ id: name, name })),
});

const extract: Operation = {
  id: "extract",
  name: "Extract",
  instruction: "",
  questions: [question("request", "yes", "no"), question("match", "new", "duplicate")],
  routes: [
    { when: {}, steps: [comment] },
    { when: { request: "no" }, steps: [close] },
    { when: { request: "yes", match: "new" }, steps: [createIssue] },
  ],
  inputs: {},
};

describe("inheritedAt", () => {
  it("adds every broader route that matches to what a row runs", () => {
    expect(inheritedAt(extract, { request: "no", match: "new" }).map(({ step }) => step)).toEqual([
      comment,
      close,
    ]);
    expect(inheritedAt(extract, { request: "yes", match: "new" }).map(({ step }) => step)).toEqual([comment]);
  });
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
