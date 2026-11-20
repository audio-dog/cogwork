import {
  keyOf,
  type ParkReason,
  Principal,
  type RunId,
  WorkflowActionPlan,
  WorkflowActionPlanStep,
  type WorkItemRef,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Coordination } from "./coordination";
import { WorkspaceRegistry } from "./registry-service";
import { SourceControlProvider } from "./source-control";
import { TriggerObservationStore } from "./trigger-observation-store";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { operationKeyOf } from "./workflow-run-admission";
import {
  failTouchpoint,
  makeWorkflowRunPendingPlans,
  type PendingPlanDependencies,
} from "./workflow-run-pending-plan";
import { WorktreeManager } from "./worktree";
import { operationInProgressSummary } from "./worktree-diagnostics";

type WorktreeBlocked = Extract<ParkReason, { readonly _tag: "WorktreeBlocked" }>;

const probedWorktreePath = ({ reason, path }: WorktreeBlocked) => (reason === "detached" ? undefined : path);

const waitingReviewTarget = (plan: WorkflowActionPlan) => {
  const waiting = plan.steps.some(
    ({ entry, status }) => entry === "cogwork.wait-for-approval" && status === "pending",
  );
  if (!waiting) return null;
  return plan.steps.find(({ target }) => target._tag === "NamedPullRequest")?.target ?? null;
};

export const makeWorkflowRunTouchpoints = Effect.fn("WorkflowRun.makeTouchpoints")(function* <E, R>(
  dependencies: PendingPlanDependencies<E, R>,
) {
  const { complete } = dependencies;
  const coordination = yield* Coordination;
  const actionPlans = yield* WorkflowActionPlanStore;
  const registry = yield* WorkspaceRegistry;
  const observationStore = yield* TriggerObservationStore;
  const sourceControl = Option.getOrNull(yield* Effect.serviceOption(SourceControlProvider));
  const worktrees = Option.getOrNull(yield* Effect.serviceOption(WorktreeManager));
  const { currentPlan, rebuildPlan, recordDecision, finishTouchpointPlan, executeClaimedPlan } =
    yield* makeWorkflowRunPendingPlans(dependencies);

  const refreshReviewPlans = Effect.fn("WorkflowRun.refreshReviewPlans")(function* () {
    if (sourceControl === null) return;
    const plans = yield* actionPlans.list;
    const admissions = yield* observationStore.admissions;
    const workspaces = (yield* registry.state).workspaces;
    yield* Effect.forEach(
      plans,
      (plan) => {
        const target = waitingReviewTarget(plan);
        if (target?._tag !== "NamedPullRequest") return Effect.void;
        const workspace = workspaces.find(({ config }) => config.id === target.workspace);
        if (!workspace) return Effect.void;
        return sourceControl.readPullRequest(workspace, `#${target.number}`).pipe(
          Effect.flatMap((pullRequest) => {
            if (pullRequest === null || pullRequest.headSha === target.headSha) return Effect.void;
            const admission = admissions.find(
              (candidate) =>
                keyOf(candidate.event.key) === plan.item &&
                candidate.subscription.workflow === plan.workflow &&
                candidate.event.revision === plan.revision,
            );
            if (!admission) return Effect.void;
            return coordination
              .handBack(admission.event.key, {
                by: "cogwork",
                note: "The pull request received a new commit. Review the new head.",
              })
              .pipe(Effect.andThen(actionPlans.remove(plan.item, plan.workflow, plan.attempt)));
          }),
        );
      },
      { discard: true },
    );
  });

  const approve = Effect.fn("WorkflowRun.approve")(function* (payload: {
    readonly item: WorkItemRef;
    readonly attempt: RunId;
    readonly digest: string;
    readonly edits?: Readonly<Record<string, string>>;
  }) {
    yield* refreshReviewPlans();
    const { plan, admission } = yield* currentPlan(payload.item, payload.attempt);
    const waiting = plan.steps.some(
      ({ entry, status }) => entry === "cogwork.wait-for-approval" && status === "pending",
    );
    if (!waiting) {
      return yield* failTouchpoint("not-awaiting-approval", "The item is not awaiting approval");
    }
    if (plan.digest !== payload.digest) {
      return yield* failTouchpoint("stale-digest", "The plan changed after it was displayed");
    }
    const edits = payload.edits ?? {};
    const knownInputs = new Set(Object.keys(plan.inputs));
    const unknownEdit = Object.keys(edits).find((field) => !knownInputs.has(field));
    if (unknownEdit !== undefined) {
      return yield* failTouchpoint("invalid-edits", `The plan has no editable input ${unknownEdit}`);
    }
    const rebuilt =
      Object.keys(edits).length === 0
        ? plan
        : yield* rebuildPlan(
            plan,
            admission,
            plan.answers,
            { ...plan.inputs, ...edits },
            plan.createdAtMillis,
          );
    const approved = WorkflowActionPlan.make({
      ...rebuilt,
      steps: rebuilt.steps.map((step) =>
        step.entry === "cogwork.wait-for-approval"
          ? WorkflowActionPlanStep.make({ ...step, status: "completed" })
          : step,
      ),
    });
    const latest = yield* coordination.read(admission.event.key);
    if (latest.revision?.observed !== undefined && latest.revision.observed !== approved.revision) {
      return yield* failTouchpoint("stale-attempt", `Attempt ${approved.attempt} is no longer current`);
    }
    yield* actionPlans.save(approved);
    yield* recordDecision(approved, "workflow.plan-approved", { digest: approved.digest });
    const execution = yield* executeClaimedPlan(approved, admission);
    yield* finishTouchpointPlan(approved, admission, execution);
    return approved.digest;
  });

  const reject = Effect.fn("WorkflowRun.reject")(function* (payload: {
    readonly item: WorkItemRef;
    readonly attempt: RunId;
    readonly note?: string;
  }) {
    const { plan, admission } = yield* currentPlan(payload.item, payload.attempt);
    const waiting = plan.steps.some(
      ({ entry, status }) => entry === "cogwork.wait-for-approval" && status === "pending",
    );
    if (!waiting) {
      return yield* failTouchpoint("not-awaiting-approval", "The item is not awaiting approval");
    }
    const latest = yield* coordination.read(admission.event.key);
    if (latest.revision?.observed !== undefined && latest.revision.observed !== plan.revision) {
      return yield* failTouchpoint("stale-attempt", `Attempt ${plan.attempt} is no longer current`);
    }
    yield* recordDecision(plan, "workflow.plan-rejected", {
      digest: plan.digest,
      note: payload.note ?? null,
    });
    yield* actionPlans.remove(plan.item, plan.workflow, plan.attempt);
    yield* coordination.recordAttempt(admission.event.key, {
      operation: operationKeyOf(admission, plan.operation),
      outcome: "succeeded",
      lineage: admission.lineage,
    });
    yield* complete(admission);
  });

  const chooseAnswer = Effect.fn("WorkflowRun.chooseAnswer")(function* (payload: {
    readonly item: WorkItemRef;
    readonly attempt: RunId;
    readonly answers: Readonly<Record<string, string>>;
    readonly inputs: Readonly<Record<string, string>>;
  }) {
    const { plan, admission } = yield* currentPlan(payload.item, payload.attempt);
    const handedToPerson = plan.steps.some(
      ({ entry, status }) => entry === "cogwork.hand-to-me" && status === "completed",
    );
    if (!handedToPerson) {
      return yield* failTouchpoint("not-handed-to-you", "The item is not handed to you");
    }
    const rebuilt = yield* rebuildPlan(
      plan,
      admission,
      payload.answers,
      { ...plan.inputs, ...payload.inputs },
      yield* Clock.currentTimeMillis,
    );
    const latest = yield* coordination.read(admission.event.key);
    if (latest.revision?.observed !== undefined && latest.revision.observed !== rebuilt.revision) {
      return yield* failTouchpoint("stale-attempt", `Attempt ${rebuilt.attempt} is no longer current`);
    }
    const principal = yield* Principal;
    yield* coordination.handBack(payload.item, { by: principal.id });
    yield* actionPlans.save(rebuilt);
    yield* recordDecision(rebuilt, "workflow.answer-chosen", {
      answers: payload.answers,
    });
    const execution = yield* executeClaimedPlan(rebuilt, admission);
    yield* finishTouchpointPlan(rebuilt, admission, execution);
  });

  const refuseBlockedWorktree = Effect.fn("WorkflowRun.refuseBlockedWorktree")(function* (
    blocked: WorktreeBlocked,
  ) {
    if (worktrees === null) return;
    const path = probedWorktreePath(blocked);
    if (path === undefined) return;
    const operation = yield* worktrees.operationInProgress(path).pipe(
      Effect.catchTag("GitError", (error) =>
        Effect.logWarning("worktree probe failed; handing back without it", {
          path,
          message: error.message,
        }).pipe(Effect.map(() => null)),
      ),
    );
    if (operation === null) return;
    return yield* failTouchpoint(
      "worktree-blocked",
      `Hand Back needs the worktree at ${path}: ${operationInProgressSummary(blocked.branch, operation)} Finish or abort it first.`,
    );
  });

  const handBack = Effect.fn("WorkflowRun.handBack")(function* (payload: {
    readonly item: WorkItemRef;
    readonly note?: string;
  }) {
    const view = yield* coordination.read(payload.item);
    if (view.park === null) {
      return yield* failTouchpoint("not-found", "This item is not parked");
    }
    if (view.park.reason._tag === "WorktreeBlocked") yield* refuseBlockedWorktree(view.park.reason);
    const principal = yield* Principal;
    yield* coordination.handBack(payload.item, { by: principal.id, note: payload.note });
  });

  return { refreshReviewPlans, approve, reject, chooseAnswer, handBack };
});
