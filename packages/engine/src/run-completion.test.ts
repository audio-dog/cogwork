import { WorkflowNodeId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { actionPlanCompletion, type RunCompletion, RunCompletionRoute } from "./run-completion";
import type { WorkflowActionPlanExecution } from "./workflow-action-plan";

const review = Schema.decodeSync(WorkflowNodeId)("review");

const cases: ReadonlyArray<readonly [string, WorkflowActionPlanExecution, RunCompletion]> = [
  [
    "Complete without a hand-off",
    { _tag: "Complete", handOff: null },
    { settle: "succeeded", attempt: "succeeded", route: RunCompletionRoute.Complete() },
  ],
  [
    "Complete with a hand-off",
    { _tag: "Complete", handOff: review },
    { settle: "succeeded", attempt: "succeeded", route: RunCompletionRoute.HandOff({ node: review }) },
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
