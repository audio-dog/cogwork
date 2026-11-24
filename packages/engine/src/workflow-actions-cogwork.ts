import {
  keyOf,
  WorkflowActionArtifact,
  type WorkflowActionTarget,
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  WorkflowNotificationId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { defaultClaimant } from "./coordination";
import { IssueTrackerError } from "./issue-tracker";
import {
  type ActionContext,
  type ActionEntry,
  type ActionExecutor,
  type ActionPhase,
  invalidTarget,
  stringInput,
} from "./workflow-action-entry";

const cogworkRow = (key: string, name: string, agentInputs: ReadonlyArray<string>) =>
  ({
    key: Schema.decodeSync(WorkflowCatalogKey)(key),
    name,
    kind: "action",
    system: null,
    connection: null,
    requires: [],
    parameters: [],
    itemKind: null,
    actsOn: ["*"],
    requiresWorkspace: false,
    workspaceSource: null,
    permissionProfile: "read-only",
    agentInputs,
    emits: [],
  }) satisfies WorkflowCatalogEntry;

const cogworkTarget = () => Effect.succeed<WorkflowActionTarget>({ _tag: "Cogwork" });

const cogworkEntry = (
  row: WorkflowCatalogEntry,
  phase: ActionPhase,
  execute: ActionExecutor,
): ActionEntry => ({ row, target: cogworkTarget, execute, phase, tools: [] });

const notify = Effect.fn("WorkflowActionPlan.notify")(function* (context: ActionContext) {
  const run = yield* context.ledger.getRun(context.plan.attempt);
  if (run === null) return yield* invalidTarget(context.step);
  yield* context.notifications
    .write(run, {
      id: WorkflowNotificationId.make(
        `${keyOf(context.item)}:${context.plan.attempt}:${context.step.writeKey}`,
      ),
      item: context.item,
      workflow: context.plan.workflow,
      operation: context.plan.operation,
      summary: stringInput(context.step, "notification"),
      answers: context.plan.answers,
      artifacts: context.plan.steps.flatMap(({ artifact }) =>
        Schema.is(WorkflowActionArtifact)(artifact) ? [artifact] : [],
      ),
      atMillis: context.plan.createdAtMillis,
    })
    .pipe(
      Effect.mapError(
        (error) =>
          new IssueTrackerError({
            reason: "unavailable",
            retryable: error.retryable,
            message: error.message,
          }),
      ),
    );
  return null;
});

const actionFailure = (error: unknown) =>
  new IssueTrackerError({
    reason: "unavailable",
    retryable: true,
    message: error instanceof Error ? error.message : String(error),
  });

const withdrawPendingApprovalRaw = Effect.fn("WorkflowActionPlan.withdrawPendingApproval")(function* (
  context: ActionContext,
) {
  const plans = yield* context.actionPlans.list;
  const waiting = plans.filter(
    (plan) =>
      plan.item === context.plan.item &&
      plan.attempt !== context.plan.attempt &&
      plan.steps.some(({ entry, status }) => entry === "cogwork.wait-for-approval" && status === "pending"),
  );
  const admissions = yield* context.observationStore.admissions;
  yield* Effect.forEach(
    waiting,
    (plan) =>
      Effect.gen(function* () {
        const matchingAdmissions = admissions.filter(
          (admission) =>
            keyOf(admission.event.key) === plan.item &&
            admission.subscription.workflow === plan.workflow &&
            admission.event.revision === plan.revision,
        );
        yield* Effect.forEach(
          matchingAdmissions,
          (admission) =>
            context.observationStore.complete(
              admission,
              context.coordination.markProcessed(admission.event.key, admission.event.revision),
            ),
          { discard: true },
        );
        yield* context.actionPlans.remove(plan.item, plan.workflow, plan.attempt);
      }),
    { discard: true },
  );
  if (waiting.length > 0) {
    yield* context.coordination.handBack(context.item, { by: defaultClaimant });
  }
  return null;
});

const withdrawPendingApproval = (context: ActionContext) =>
  withdrawPendingApprovalRaw(context).pipe(Effect.mapError(actionFailure));

const completes = () => Effect.succeed(null);

export const cogworkActionEntries = {
  "cogwork.notify": cogworkEntry(
    cogworkRow("cogwork.notify", "Notify me", ["notification"]),
    "notify",
    notify,
  ),
  "cogwork.wait-for-approval": cogworkEntry(
    cogworkRow("cogwork.wait-for-approval", "Wait for my approval", ["approval_request"]),
    "approval",
    completes,
  ),
  "cogwork.withdraw-pending-approval": cogworkEntry(
    cogworkRow("cogwork.withdraw-pending-approval", "Withdraw the pending approval", []),
    "write",
    withdrawPendingApproval,
  ),
  "cogwork.hand-to-me": cogworkEntry(
    cogworkRow("cogwork.hand-to-me", "Hand to me", ["hand_off"]),
    "terminal",
    completes,
  ),
  "cogwork.stop": cogworkEntry(cogworkRow("cogwork.stop", "Stop", []), "terminal", completes),
};
