import {
  LineageId,
  RunId,
  WorkflowNodeId,
  type WorkflowOperationElement,
  WorkItemKey,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { fold } from "./coordination";
import {
  actionPlanCompletion,
  failedAttemptCompletion,
  fanOutCompletion,
  type RunCompletion,
  RunCompletionRoute,
  stuckCompletion,
} from "./run-completion";
import type { WorkflowActionPlanExecution } from "./workflow-action-plan";
import { admission } from "./workflow-run-admissions-fixtures";

const review = Schema.decodeSync(WorkflowNodeId)("review");

const cases: ReadonlyArray<readonly [string, WorkflowActionPlanExecution, RunCompletion]> = [
  [
    "Complete without a hand-off",
    { _tag: "Complete", handOff: null },
    { settle: "succeeded", attempt: { outcome: "succeeded" }, route: RunCompletionRoute.Complete() },
  ],
  [
    "Complete with a hand-off",
    { _tag: "Complete", handOff: review },
    {
      settle: "succeeded",
      attempt: { outcome: "succeeded" },
      route: RunCompletionRoute.HandOff({ node: review }),
    },
  ],
  ["Retry", { _tag: "Retry" }, { settle: "failed", attempt: null, route: RunCompletionRoute.Retry() }],
  [
    "Replan",
    { _tag: "Replan" },
    { settle: "interrupted", attempt: null, route: RunCompletionRoute.Replan() },
  ],
  [
    "AwaitingApproval",
    { _tag: "AwaitingApproval" },
    { settle: "succeeded", attempt: null, route: RunCompletionRoute.Park() },
  ],
  [
    "HandedToYou",
    { _tag: "HandedToYou" },
    { settle: "succeeded", attempt: null, route: RunCompletionRoute.Park() },
  ],
  ["Parked", { _tag: "Parked" }, { settle: "failed", attempt: null, route: RunCompletionRoute.Park() }],
];

describe("actionPlanCompletion", () => {
  it.each(cases)("%s settles, records, and routes", (_name, execution, expected) => {
    assert.deepStrictEqual(actionPlanCompletion(execution), expected);
  });
});

describe("failedAttemptCompletion", () => {
  const operation = { workflow: "workflow", operation: "operate" };
  const failures = (count: number) =>
    fold(
      {
        claim: null,
        attempts: Array.from({ length: count }, (_, index) => ({
          operation,
          outcome: "failed" as const,
          atMillis: index + 1,
          lineage: { root: LineageId.make("issue:1"), parent: null, hop: 0 },
        })),
        handbacks: [],
        parks: [],
        revision: null,
      },
      "cogwork",
    );
  const retry = (settle: "failed" | "declined"): RunCompletion => ({
    settle,
    attempt: null,
    route: RunCompletionRoute.Retry(),
  });

  const failureCases: ReadonlyArray<readonly [string, number, "failed" | "declined", RunCompletion]> = [
    ["the first failure retries", 1, "failed", retry("failed")],
    ["the second failure retries", 2, "failed", retry("failed")],
    ["a declined second failure retries as declined", 2, "declined", retry("declined")],
    [
      "the third failure exhausts and parks",
      3,
      "declined",
      {
        settle: "exhausted",
        attempt: null,
        route: RunCompletionRoute.Exhaust({ park: { _tag: "Exhausted", reason: "Harness exited" } }),
      },
    ],
  ];

  it.each(failureCases)("%s", (_name, count, status, expected) => {
    assert.deepStrictEqual(
      failedAttemptCompletion(failures(count), operation, "Harness exited", status),
      expected,
    );
  });
});

describe("stuckCompletion", () => {
  it("records a failed attempt and parks Stuck with the summary", () => {
    assert.deepStrictEqual(stuckCompletion("Needs a product decision"), {
      settle: "failed",
      attempt: { outcome: "failed", reason: "Needs a product decision" },
      route: RunCompletionRoute.ParkStuck({ park: { _tag: "Stuck", summary: "Needs a product decision" } }),
    });
  });
});

describe("fanOutCompletion", () => {
  it("admits one child per element in order and records a succeeded attempt", () => {
    const element = (summary: string): WorkflowOperationElement => ({ summary, answers: {}, inputs: {} });
    const run = Schema.decodeSync(RunId)("run-1");
    const parent = WorkItemKey.make("schedule:daily-summary:1000");
    const { settle, attempt, route } = fanOutCompletion(admission, run, [
      element("first"),
      element("second"),
    ]);

    assert.deepStrictEqual({ settle, attempt }, { settle: "succeeded", attempt: { outcome: "succeeded" } });
    assert.deepStrictEqual(
      route.children.map((child) => [child.admission.event.key, child.element.summary]),
      [
        [{ _tag: "FanOutChild", parent, run, position: 0 }, "first"],
        [{ _tag: "FanOutChild", parent, run, position: 1 }, "second"],
      ],
    );
  });
});
