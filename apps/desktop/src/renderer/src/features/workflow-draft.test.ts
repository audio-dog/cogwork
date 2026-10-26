import { describe, expect, it } from "vitest";
import { handOffTo, pickAction, pickTrigger } from "./workflow-catalog";
import { workflowEdits } from "./workflow-draft";
import type { Operation, Workflow } from "./workflow-model";
import { operationsInOrder } from "./workflow-overview";

const comment = pickAction("github", "comment");

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

const review = operation("review", { name: "Review" });
const classify = operation("classify", {
  questions: [{ id: "ask", text: "", choices: [{ id: "review-request", name: "review-request" }] }],
  routes: [{ when: { ask: "review-request" }, actions: [comment, handOffTo(review)] }],
});
const unreached = operation("digest");

const workflow: Workflow = {
  id: "slack-review",
  name: "Slack → Review",
  enabled: true,
  workspaces: { kind: "every" },
  triggers: [],
  operations: [classify, unreached, review],
};

const actionsOfClassify = (edited: Workflow) =>
  edited.operations
    .find((candidate) => candidate.id === "classify")
    ?.routes[0]?.actions.map((action) => action.itemName);

describe("workflowEdits", () => {
  it("renames every hand-off that points at a renamed Operation", () => {
    expect(
      actionsOfClassify(workflowEdits.renameOperation(workflow, "review", "Review the pull request")),
    ).toEqual(["Post a comment", "Review the pull request"]);
  });

  it("drops every hand-off that points at a removed Operation", () => {
    expect(actionsOfClassify(workflowEdits.removeOperation(workflow, "review"))).toEqual(["Post a comment"]);
  });

  it("adds a Trigger the Workflow already has only once", () => {
    const trigger = pickTrigger("slack", "directed");
    const twice = workflowEdits.addTrigger(workflowEdits.addTrigger(workflow, trigger), trigger);
    expect(twice.triggers).toEqual([trigger]);
  });
});

describe("operationsInOrder", () => {
  it("follows the hand-offs, then keeps every Operation no hand-off reaches", () => {
    expect(operationsInOrder(workflow).map((candidate) => candidate.id)).toEqual([
      "classify",
      "review",
      "digest",
    ]);
  });
});
