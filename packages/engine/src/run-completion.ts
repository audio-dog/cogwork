import type {
  OperationKey,
  ParkReason,
  RunId,
  RunRecord,
  WorkflowNodeId,
  WorkflowOperationElement,
} from "@cogwork/contracts";
import * as Data from "effect/Data";
import type { CoordinationView } from "./coordination";
import type { TriggerAdmission } from "./trigger-observation-admission";
import type { WorkflowActionPlanExecution } from "./workflow-action-plan";
import { fanOutAdmission } from "./workflow-run-admission";

export type RunCompletionRoute = Data.TaggedEnum<{
  Complete: Record<never, never>;
  HandOff: { readonly node: WorkflowNodeId };
  Retry: Record<never, never>;
  Replan: Record<never, never>;
  Park: Record<never, never>;
  Exhaust: { readonly park: ParkReason };
  ParkStuck: { readonly park: ParkReason };
  FanOut: {
    readonly children: ReadonlyArray<{
      readonly admission: TriggerAdmission;
      readonly element: WorkflowOperationElement;
    }>;
  };
}>;
export const RunCompletionRoute = Data.taggedEnum<RunCompletionRoute>();

export type CompletionAttempt =
  | { readonly outcome: "succeeded" }
  | { readonly outcome: "failed"; readonly reason: string };

export interface RunCompletion {
  readonly settle: Extract<
    RunRecord["status"],
    "succeeded" | "failed" | "declined" | "exhausted" | "interrupted"
  >;
  readonly attempt: CompletionAttempt | null;
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

const succeeded: CompletionAttempt = { outcome: "succeeded" };

const completedRoute = (handOff: WorkflowNodeId | null) =>
  handOff === null ? RunCompletionRoute.Complete() : RunCompletionRoute.HandOff({ node: handOff });

export const actionPlanCompletion = (execution: WorkflowActionPlanExecution): RunCompletion =>
  execution._tag === "Complete"
    ? { settle: "succeeded", attempt: succeeded, route: completedRoute(execution.handOff) }
    : unfinishedCompletion[execution._tag];

export const failedAttemptCompletion = (
  afterAttempt: CoordinationView,
  key: OperationKey,
  reason: string,
  status: "failed" | "declined",
): RunCompletion =>
  afterAttempt.counters(key).exhausted
    ? {
        settle: "exhausted",
        attempt: null,
        route: RunCompletionRoute.Exhaust({ park: { _tag: "Exhausted", reason } }),
      }
    : { settle: status, attempt: null, route: RunCompletionRoute.Retry() };

export const stuckCompletion = (summary: string): RunCompletion => ({
  settle: "failed",
  attempt: { outcome: "failed", reason: summary },
  route: RunCompletionRoute.ParkStuck({ park: { _tag: "Stuck", summary } }),
});

export const fanOutCompletion = (
  admission: TriggerAdmission,
  run: RunId,
  elements: ReadonlyArray<WorkflowOperationElement>,
) =>
  ({
    settle: "succeeded",
    attempt: succeeded,
    route: RunCompletionRoute.FanOut({
      children: elements.map((element, position) => ({
        admission: fanOutAdmission(admission, run, position, element),
        element,
      })),
    }),
  }) satisfies RunCompletion;
