import type { RunRecord, WorkflowNodeId } from "@cogwork/contracts";
import * as Data from "effect/Data";
import type { WorkflowActionPlanExecution } from "./workflow-action-plan";

export type RunCompletionRoute = Data.TaggedEnum<{
  Complete: Record<never, never>;
  HandOff: { readonly node: WorkflowNodeId };
  Retry: Record<never, never>;
  Replan: Record<never, never>;
  Park: Record<never, never>;
}>;
export const RunCompletionRoute = Data.taggedEnum<RunCompletionRoute>();

export interface RunCompletion {
  readonly settle: Extract<RunRecord["status"], "succeeded" | "failed" | "interrupted">;
  readonly attempt: "succeeded" | null;
  readonly route: RunCompletionRoute;
}

type UnfinishedExecution = Exclude<WorkflowActionPlanExecution["_tag"], "Complete">;

const unfinishedCompletion: Record<UnfinishedExecution, RunCompletion> = {
  Retry: { settle: "failed", attempt: null, route: RunCompletionRoute.Retry() },
  Replan: { settle: "interrupted", attempt: null, route: RunCompletionRoute.Replan() },
  AwaitingApproval: { settle: "succeeded", attempt: null, route: RunCompletionRoute.Park() },
  HandedToYou: { settle: "succeeded", attempt: null, route: RunCompletionRoute.Park() },
  Parked: { settle: "failed", attempt: null, route: RunCompletionRoute.Park() },
};

const completedRoute = (handOff: WorkflowNodeId | null) =>
  handOff === null ? RunCompletionRoute.Complete() : RunCompletionRoute.HandOff({ node: handOff });

export const actionPlanCompletion = (execution: WorkflowActionPlanExecution): RunCompletion =>
  execution._tag === "Complete"
    ? { settle: "succeeded", attempt: "succeeded", route: completedRoute(execution.handOff) }
    : unfinishedCompletion[execution._tag];
