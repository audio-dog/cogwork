import { describe, expect, it } from "vitest";
import { handOffTo, pickAction } from "./workflow-catalog";
import { workflowEdits } from "./workflow-draft";
import type { Operation, Workflow } from "./workflow-model";

const comment = pickAction("github", "comment");

const operation = (id: string, overrides: Partial<Operation> = {}): Operation => ({
  id,
  name: id,
  instruction: "",
  model: { harness: null, model: null },
  questions: [],
  routes: [],
  inputs: {},
  ...overrides,
});

describe("workflowEdits", () => {
  const review = operation("review", { name: "Review" });
  const classify = operation("classify", {
    questions: [
      { id: "ask", key: "ask", text: "", choices: [{ id: "review-request", name: "review-request" }] },
    ],
    routes: [{ when: { ask: "review-request" }, steps: [comment, handOffTo(review)] }],
  });
  const workflow: Workflow = {
    id: "slack-review",
    name: "Slack → Review",
    summary: "",
    origin: "yours",
    enabled: true,
    workspaces: [],
    triggers: [],
    operations: [classify, review],
    activity: { runsLastWeek: 0, lastRun: "never", waiting: 0 },
  };
  const stepsOfClassify = (edited: Workflow) =>
    edited.operations
      .find((candidate) => candidate.id === "classify")
      ?.routes[0]?.steps.map((step) => step.itemName);

  it("renames every hand-off that points at a renamed Operation", () => {
    expect(
      stepsOfClassify(workflowEdits.renameOperation(workflow, "review", "Review the pull request")),
    ).toEqual(["Post a comment", "Review the pull request"]);
  });

  it("drops every hand-off that points at a removed Operation", () => {
    expect(stepsOfClassify(workflowEdits.removeOperation(workflow, "review"))).toEqual(["Post a comment"]);
  });
});
