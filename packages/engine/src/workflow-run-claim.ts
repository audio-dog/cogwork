import { keyOf, type ParkReason, type RunId, type RunRecord } from "@cogwork/contracts";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { Coordination } from "./coordination";
import { failureDetail, RefusedResult, refusalForAgent, refusalForPerson } from "./operation-result";
import { RunLedger } from "./run-ledger";
import { type TriggerAdmission, TriggerObservationStore } from "./trigger-observation";
import type { WorkflowActionPlanDecodeError } from "./workflow-action-entry";
import { type operationKeyOf, parkedAdmission } from "./workflow-run-admission";

const unexpectedFailureText = (cause: Cause.Cause<unknown>) =>
  failureDetail(cause).trim() || "The Run failed without an error message";

export type ClaimState = Data.TaggedEnum<{
  Idle: Record<never, never>;
  Claimed: {
    readonly key: ReturnType<typeof operationKeyOf>;
    readonly run: RunId | null;
    readonly lineageParent: RunId | null;
  };
  Attempted: { readonly run: RunId | null; readonly status: "succeeded" | "failed" };
}>;
export const ClaimState = Data.taggedEnum<ClaimState>();
export type ClaimedWork = Data.TaggedEnum.Value<ClaimState, "Claimed">;

const planRefusal = {
  invalid: { status: "failed", result: (message: string) => RefusedResult.ActionPlanRefused({ message }) },
  declined: { status: "declined", result: (reason: string) => RefusedResult.PullRequestDeclined({ reason }) },
} as const;

export const makeClaim = (previousResultIssues: Ref.Ref<ReadonlyMap<string, string>>) =>
  Effect.gen(function* () {
    const coordination = yield* Coordination;
    const ledger = yield* RunLedger;
    const observationStore = yield* TriggerObservationStore;

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
      yield* Ref.set(claimed, ClaimState.Attempted({ run: work.run, status: attempt.outcome }));
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

    const refuseResult = Effect.fn("WorkflowRun.refuseResult")(function* (
      admission: TriggerAdmission,
      claimed: Ref.Ref<ClaimState>,
      work: ClaimedWork,
      refusal: RefusedResult,
      status: "failed" | "declined" = "failed",
    ) {
      yield* Ref.update(previousResultIssues, (current) =>
        new Map(current).set(keyOf(admission.event.key), refusalForAgent(refusal)),
      );
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
        Attempted: ({ status }) =>
          settleClaimed(claimed, status).pipe(Effect.andThen(Effect.failCause(cause))),
      });
    });

    return {
      settleClaimed,
      recordClaimedAttempt,
      claimItem,
      closeRevision,
      complete,
      parkCappedLineage,
      skipNoLongerMatching,
      rejectPlan,
      parkClaimed,
      failAttempt,
      refuseResult,
      refusePlan,
      recoverClaimed,
    };
  });
