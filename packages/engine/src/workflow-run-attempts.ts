import {
  type AgUiEvent,
  keyOf,
  type ParkReason,
  type RunId,
  type RunRecord,
  WorkflowActionPlan,
  type WorkflowOperationElement,
} from "@cogwork/contracts";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Coordination } from "./coordination";
import {
  failureDetail,
  RefusedResult,
  refusalForAgent,
  refusalForPerson,
  refusalResumesSession,
} from "./operation-result";
import { actionPlanCompletion, type RunCompletion, RunCompletionRoute } from "./run-completion";
import { RunLedger } from "./run-ledger";
import { RunRecorder } from "./run-recorder";
import type { TriggerAdmission } from "./trigger-observation-admission";
import { TriggerObservationStore } from "./trigger-observation-store";
import type { WorkflowActionPlanDecodeError } from "./workflow-action-entry";
import { buildWorkflowActionPlan, executeWorkflowActionPlan } from "./workflow-action-plan";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import {
  fanOutAdmission,
  handOffAdmission,
  type operationKeyOf,
  parkedAdmission,
} from "./workflow-run-admission";

const encodeActionPlan = Schema.encodeSync(Schema.fromJsonString(WorkflowActionPlan));

const unexpectedFailureText = (cause: Cause.Cause<unknown>) =>
  failureDetail(cause).trim() || "The Run failed without an error message";

export type ClaimState = Data.TaggedEnum<{
  Idle: Record<never, never>;
  Claimed: {
    readonly key: ReturnType<typeof operationKeyOf>;
    readonly run: RunId | null;
    readonly lineageParent: RunId | null;
  };
  Attempted: {
    readonly key: ReturnType<typeof operationKeyOf>;
    readonly run: RunId | null;
    readonly status: "succeeded" | "failed";
  };
}>;
export const ClaimState = Data.taggedEnum<ClaimState>();
export type ClaimedWork = Data.TaggedEnum.Value<ClaimState, "Claimed">;

export interface PriorRefusal {
  readonly agentText: string;
  readonly key: ClaimedWork["key"];
  readonly resumableRun: RunId | null;
}

const sameOperation = (left: ClaimedWork["key"], right: ClaimedWork["key"]) =>
  left.workflow === right.workflow && left.operation === right.operation;

export const resendOf = (prior: PriorRefusal | null, key: ClaimedWork["key"]) =>
  prior?.resumableRun && sameOperation(prior.key, key)
    ? {
        run: prior.resumableRun,
        request: `${prior.agentText}\n\nDo no other work unless an issue above needs it.`,
      }
    : null;

type BuildInput = Parameters<typeof buildWorkflowActionPlan>[0];

export type PullRequestBuildInput = (
  runBranch: string | null,
) => Pick<BuildInput, "sourceControl" | "worktrees" | "runBranch">;

export type AcceptedOutput =
  | BuildInput["output"]
  | { readonly elements: ReadonlyArray<WorkflowOperationElement> };

export interface AcceptedResult {
  readonly admission: TriggerAdmission;
  readonly claimed: Ref.Ref<ClaimState>;
  readonly accepted: ClaimedWork;
  readonly run: RunRecord;
  readonly output: AcceptedOutput;
  readonly startedAtMillis: number;
  readonly plan: Pick<
    BuildInput,
    "document" | "operation" | "catalog" | "workspaces" | "workflowRevision" | "pullRequestSnapshots"
  >;
}

const planRefusal = {
  invalid: { status: "failed", result: (message: string) => RefusedResult.ActionPlanRefused({ message }) },
  declined: { status: "declined", result: (reason: string) => RefusedResult.PullRequestDeclined({ reason }) },
} as const;

export const makeWorkflowRunAttempts = Effect.fn("WorkflowRun.makeAttempts")(function* (
  pullRequestBuildInput: PullRequestBuildInput,
) {
  const coordination = yield* Coordination;
  const ledger = yield* RunLedger;
  const recorder = yield* RunRecorder;
  const actionPlans = yield* WorkflowActionPlanStore;
  const observationStore = yield* TriggerObservationStore;
  const previousRefusals = yield* Ref.make<ReadonlyMap<string, PriorRefusal>>(new Map());

  const takePriorRefusal = (itemKey: string) =>
    Ref.modify(previousRefusals, (current) => {
      const prior = current.get(itemKey) ?? null;
      if (prior === null) return [prior, current];
      return [prior, new Map(current).set(itemKey, { ...prior, resumableRun: null })];
    });

  const settleRun = (attempt: RunId | null, status: RunRecord["status"]) =>
    attempt === null
      ? Effect.void
      : Effect.flatMap(Clock.currentTimeMillis, (endedAtMillis) =>
          ledger.updateRun(attempt, { status, usage: null, endedAtMillis }),
        );

  const settleClaimed = Effect.fn("WorkflowRun.settleClaimed")(function* (
    claimed: Ref.Ref<ClaimState>,
    status: RunRecord["status"],
  ) {
    const settlement = ClaimState.$match(yield* Ref.get(claimed), {
      Idle: () => ({ run: null, next: ClaimState.Idle() }),
      Claimed: ({ key, run }) => ({
        run,
        next:
          status === "interrupted"
            ? ClaimState.Claimed({ key, run: null, lineageParent: null })
            : ClaimState.Idle(),
      }),
      Attempted: ({ run }) => ({ run, next: ClaimState.Idle() }),
    });
    yield* settleRun(settlement.run, status);
    yield* Ref.set(claimed, settlement.next);
  });

  const recordClaimedAttempt = Effect.fn("WorkflowRun.recordClaimedAttempt")(function* (
    admission: TriggerAdmission,
    claimed: Ref.Ref<ClaimState>,
    work: ClaimedWork,
    attempt: { readonly outcome: "succeeded" } | { readonly outcome: "failed"; readonly reason: string },
  ) {
    const view = yield* coordination.recordAttempt(admission.event.key, {
      ...attempt,
      operation: work.key,
      lineage: admission.lineage,
    });
    yield* Ref.set(claimed, ClaimState.Attempted({ key: work.key, run: work.run, status: attempt.outcome }));
    return view;
  });

  const claimItem = (admission: TriggerAdmission, claimed: Ref.Ref<ClaimState>, work: ClaimedWork) =>
    Effect.acquireRelease(
      coordination
        .claim(admission.event.key, { operation: work.key, lineage: admission.lineage })
        .pipe(Effect.tap(() => Ref.set(claimed, work))),
      (activeClaim) =>
        coordination
          .release(admission.event.key, activeClaim)
          .pipe(Effect.catch((error) => Effect.logError("Workflow Claim release failed", { error }))),
    );

  const closeRevision = (admission: TriggerAdmission) =>
    coordination.markProcessed(admission.event.key, admission.event.revision);

  const complete = Effect.fn("WorkflowRun.complete")(function* (admission: TriggerAdmission) {
    yield* observationStore.complete(admission, closeRevision(admission));
  });

  const parkCappedLineage = Effect.fn("WorkflowRun.parkCappedLineage")(function* (
    admission: TriggerAdmission,
    key: ReturnType<typeof operationKeyOf>,
  ) {
    const view = yield* coordination.read(admission.event.key);
    if (!view.counters(key).hopCapped) return false;
    yield* coordination.park(admission.event.key, { _tag: "HopCap" }, key);
    yield* complete(admission);
    return true;
  });

  const skipNoLongerMatching = Effect.fn("WorkflowRun.skipNoLongerMatching")(function* (
    admission: TriggerAdmission,
    reason: string,
  ) {
    const skipped: TriggerAdmission = {
      ...admission,
      event: { ...admission.event, payload: { _tag: "NoLongerMatches", reason } },
    };
    yield* observationStore.putAll([skipped]);
    yield* complete(skipped);
    return "skipped" as const;
  });

  const rejectPlan = (admission: TriggerAdmission, reason: string) =>
    coordination
      .park(admission.event.key, { _tag: "PlanRejected", reason, entry: admission.event.entry })
      .pipe(
        Effect.andThen(complete(admission)),
        Effect.map(() => "skipped" as const),
      );

  const parkClaimed = Effect.fn("WorkflowRun.parkClaimed")(function* (
    admission: TriggerAdmission,
    work: ClaimedWork,
    reason: ParkReason,
  ) {
    yield* coordination.park(admission.event.key, reason, work.key);
    if (work.lineageParent === null) return;
    yield* observationStore.putAll([parkedAdmission(admission, work.lineageParent)]);
  });

  const failAttempt = Effect.fn("WorkflowRun.failAttempt")(function* (
    admission: TriggerAdmission,
    claimed: Ref.Ref<ClaimState>,
    work: ClaimedWork,
    reason: string,
    status: "failed" | "declined" = "failed",
  ) {
    const view = yield* recordClaimedAttempt(admission, claimed, work, { outcome: "failed", reason });
    const exhausted = view.counters(work.key).exhausted;
    yield* settleClaimed(claimed, exhausted ? "exhausted" : status);
    if (!exhausted) return "retry" as const;
    yield* parkClaimed(admission, work, { _tag: "Exhausted", reason });
    return "completed" as const;
  });

  const refusePreparation = Effect.fn("WorkflowRun.refusePreparation")(function* (
    admission: TriggerAdmission,
    claimed: Ref.Ref<ClaimState>,
    work: ClaimedWork,
    reason: string,
    park: ParkReason | null,
  ) {
    if (park === null) return yield* failAttempt(admission, claimed, work, reason);
    yield* recordClaimedAttempt(admission, claimed, work, { outcome: "failed", reason });
    yield* settleClaimed(claimed, "failed");
    yield* parkClaimed(admission, work, park);
    return "completed" as const;
  });

  const refuseResult = Effect.fn("WorkflowRun.refuseResult")(function* (
    admission: TriggerAdmission,
    claimed: Ref.Ref<ClaimState>,
    work: ClaimedWork,
    refusal: RefusedResult,
    status: "failed" | "declined" = "failed",
  ) {
    const prior: PriorRefusal = {
      agentText: refusalForAgent(refusal),
      key: work.key,
      resumableRun: refusalResumesSession(refusal) ? work.run : null,
    };
    yield* Ref.update(previousRefusals, (current) => new Map(current).set(keyOf(admission.event.key), prior));
    return yield* failAttempt(admission, claimed, work, refusalForPerson(refusal), status);
  });

  const refusePlan = (
    admission: TriggerAdmission,
    claimed: Ref.Ref<ClaimState>,
    work: ClaimedWork,
    error: WorkflowActionPlanDecodeError,
  ) =>
    error.reason === "unavailable"
      ? settleClaimed(claimed, "failed").pipe(Effect.map(() => "retry" as const))
      : refuseResult(
          admission,
          claimed,
          work,
          planRefusal[error.reason].result(error.message),
          planRefusal[error.reason].status,
        );

  const recoverClaimed = Effect.fn("WorkflowRun.recoverClaimed")(function* <E>(
    admission: TriggerAdmission,
    claimed: Ref.Ref<ClaimState>,
    cause: Cause.Cause<E>,
  ) {
    return yield* ClaimState.$match(yield* Ref.get(claimed), {
      Idle: () => Effect.failCause(cause),
      Claimed: (work) => failAttempt(admission, claimed, work, unexpectedFailureText(cause)),
      Attempted: ({ status }) => settleClaimed(claimed, status).pipe(Effect.andThen(Effect.failCause(cause))),
    });
  });

  const settleCompletion = Effect.fn("WorkflowRun.settleCompletion")(function* (
    admission: TriggerAdmission,
    claimed: Ref.Ref<ClaimState>,
    work: ClaimedWork,
    completion: RunCompletion,
  ) {
    if (completion.attempt !== null) {
      yield* recordClaimedAttempt(admission, claimed, work, { outcome: completion.attempt });
    }
    yield* settleClaimed(claimed, completion.settle);
  });

  const followCompletion = (admission: TriggerAdmission, completion: RunCompletion, lineageParent: RunId) =>
    RunCompletionRoute.$match(completion.route, {
      Complete: () => complete(admission).pipe(Effect.map(() => "completed" as const)),
      HandOff: ({ node }) => Effect.succeed(handOffAdmission(admission, node, lineageParent)),
      Retry: () => Effect.succeed("retry" as const),
      Replan: () => Effect.succeed(admission),
      Park: () => Effect.succeed("completed" as const),
    });

  const actOnResult = Effect.fn("WorkflowRun.actOnResult")(function* ({
    admission,
    claimed,
    accepted,
    run,
    output,
    startedAtMillis,
    plan,
  }: AcceptedResult) {
    if ("elements" in output) {
      const children = output.elements.map((element, position) => ({
        admission: fanOutAdmission(admission, run.id, position, element),
        element,
      }));
      const acceptPlans = (plans: ReadonlyArray<WorkflowActionPlan>) =>
        actionPlans.createAll(plans).pipe(
          Effect.andThen(
            Effect.forEach(
              children,
              ({ admission: child }) =>
                coordination.observe(child.event.key, child.event.revision, child.event.cause),
              { discard: true },
            ),
          ),
          Effect.andThen(recordClaimedAttempt(admission, claimed, accepted, { outcome: "succeeded" })),
          Effect.andThen(settleClaimed(claimed, "succeeded")),
          Effect.andThen(
            observationStore.fanOut(
              admission,
              children.map(({ admission: child }) => child),
              closeRevision(admission),
            ),
          ),
          Effect.map(() => "completed" as const),
        );
      return yield* Effect.forEach(children, ({ admission: child, element }) =>
        buildWorkflowActionPlan({
          ...plan,
          admission: child,
          output: element,
          attempt: run.id,
          createdAtMillis: startedAtMillis,
          ...pullRequestBuildInput(run.branch),
        }),
      ).pipe(
        Effect.matchEffect({
          onFailure: (error) => refusePlan(admission, claimed, accepted, error),
          onSuccess: acceptPlans,
        }),
      );
    }

    const actionPlanResult = yield* Effect.result(
      buildWorkflowActionPlan({
        ...plan,
        admission,
        output,
        attempt: run.id,
        createdAtMillis: yield* Clock.currentTimeMillis,
        ...pullRequestBuildInput(run.branch),
      }),
    );
    if (Result.isFailure(actionPlanResult)) {
      return yield* refusePlan(admission, claimed, accepted, actionPlanResult.failure);
    }
    const actionPlan = yield* actionPlans.create(actionPlanResult.success);
    const actionPlanEvent: AgUiEvent = {
      type: "CUSTOM",
      name: "workflow.action-plan",
      value: { object: actionPlan, raw: encodeActionPlan(actionPlan) },
    };
    yield* recorder.record(run, actionPlanEvent);
    const completion = actionPlanCompletion(yield* executeWorkflowActionPlan(actionPlan, admission));
    yield* settleCompletion(admission, claimed, accepted, completion);
    return yield* followCompletion(admission, completion, run.id);
  });

  return {
    previousRefusals,
    takePriorRefusal,
    settleClaimed,
    recordClaimedAttempt,
    claimItem,
    complete,
    parkCappedLineage,
    skipNoLongerMatching,
    rejectPlan,
    refuseResult,
    refusePreparation,
    recoverClaimed,
    settleCompletion,
    followCompletion,
    actOnResult,
  };
});

export type WorkflowRunAttempts = Effect.Success<ReturnType<typeof makeWorkflowRunAttempts>>;
