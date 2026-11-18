import {
  keyOf,
  matchWorkflowTransitions,
  type RunId,
  type WorkflowActionPlan,
  type WorkflowAgentInputValue,
  WorkflowTouchpointFailure,
  type WorkItemRef,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Coordination } from "./coordination";
import { WorkspaceRegistry } from "./registry";
import { completeActionPlanExecution, RunCompletionRoute } from "./run-completion";
import { RunLedger } from "./run-ledger";
import { RunRecorder } from "./run-recorder";
import { type TriggerAdmission, TriggerObservationStore } from "./trigger-observation";
import { Workflows } from "./workflow";
import {
  buildWorkflowActionPlan,
  executeWorkflowActionPlan,
  type WorkflowActionPlanExecution,
} from "./workflow-action-plan";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { handOffAdmission, operationKeyOf } from "./workflow-run-admission";
import type { PullRequestBuildInput, WorkflowRunAttempts } from "./workflow-run-attempts";

const encodeDecision = Schema.encodeSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)));

const agentInputIsMissing = (value: WorkflowAgentInputValue | undefined) =>
  value === undefined || (typeof value === "string" && value.trim().length === 0);

export const touchpointFailure = (reason: WorkflowTouchpointFailure["reason"], message: string) =>
  new WorkflowTouchpointFailure({ reason, message });

export const failTouchpoint = (reason: WorkflowTouchpointFailure["reason"], message: string) =>
  Effect.fail(touchpointFailure(reason, message));

export interface PendingPlanDependencies<E, R> {
  readonly complete: WorkflowRunAttempts["complete"];
  readonly executeAdmission: (admission: TriggerAdmission) => Effect.Effect<unknown, E, R>;
  readonly pullRequestBuildInput: PullRequestBuildInput;
}

export const makeWorkflowRunPendingPlans = Effect.fn("WorkflowRun.makePendingPlans")(function* <E, R>({
  complete,
  executeAdmission,
  pullRequestBuildInput,
}: PendingPlanDependencies<E, R>) {
  const workflows = yield* Workflows;
  const coordination = yield* Coordination;
  const ledger = yield* RunLedger;
  const recorder = yield* RunRecorder;
  const actionPlans = yield* WorkflowActionPlanStore;
  const registry = yield* WorkspaceRegistry;
  const observationStore = yield* TriggerObservationStore;

  const currentPlan = Effect.fn("WorkflowRun.currentPlan")(function* (item: WorkItemRef, attempt: RunId) {
    const itemKey = keyOf(item);
    const plan = yield* actionPlans.find(itemKey, attempt);
    if (plan === null) {
      const hasCurrentPlan = (yield* actionPlans.list).some((candidate) => candidate.item === itemKey);
      return yield* failTouchpoint(
        hasCurrentPlan ? "stale-attempt" : "not-found",
        hasCurrentPlan ? `Attempt ${attempt} is no longer current` : "No pending plan exists for this item",
      );
    }
    const view = yield* coordination.read(item);
    const observedRevision = view.revision?.observed;
    if (observedRevision !== undefined && observedRevision !== plan.revision) {
      return yield* failTouchpoint("stale-attempt", `Attempt ${attempt} is no longer current`);
    }
    const admissions = yield* observationStore.admissions;
    const admission = admissions.find(
      (candidate) =>
        keyOf(candidate.event.key) === itemKey &&
        candidate.subscription.workflow === plan.workflow &&
        candidate.event.revision === plan.revision,
    );
    if (admission === undefined) {
      return yield* failTouchpoint("stale-attempt", `Attempt ${attempt} is no longer current`);
    }
    return { plan, admission };
  });

  const rebuildPlan = Effect.fn("WorkflowRun.rebuildPlan")(function* (
    plan: WorkflowActionPlan,
    admission: TriggerAdmission,
    answers: Readonly<Record<string, string>>,
    inputs: Readonly<Record<string, WorkflowAgentInputValue>>,
    createdAtMillis: number,
  ) {
    const record = yield* workflows.get({ id: plan.workflow });
    const document = record.publishedCopy;
    const operation = document?.operations.find(({ id }) => id === plan.operation);
    if (document === null || document === undefined || operation === undefined) {
      return yield* failTouchpoint("unavailable", "The published Workflow operation is unavailable");
    }
    if (record.publishedRevision !== plan.workflowRevision) {
      return yield* failTouchpoint(
        "stale-digest",
        "The published Workflow changed after this plan was displayed",
      );
    }
    const catalogResult = yield* workflows.catalog;
    const registryState = yield* registry.state;
    const unknownAnswer = Object.keys(answers).find(
      (answer) => !operation.questions.some(({ id }) => id === answer),
    );
    const invalidAnswer = operation.questions.find(
      (question) => !question.choices.some(({ id }) => id === answers[question.id]),
    );
    const matchedTransitions = matchWorkflowTransitions(operation, answers);
    const invalidAnswers =
      unknownAnswer !== undefined || invalidAnswer !== undefined || matchedTransitions.length === 0;
    if (invalidAnswers) {
      return yield* failTouchpoint("invalid-edits", "The answers do not match the published Operation");
    }
    const matchedEntries = new Set(
      matchedTransitions.flatMap(({ actions }) => actions.map(({ entry }) => entry)),
    );
    const missingInput = catalogResult.catalog.entries
      .filter(({ key }) => matchedEntries.has(key))
      .flatMap(({ agentInputs }) => agentInputs)
      .find((input) => agentInputIsMissing(inputs[input]));
    if (missingInput !== undefined) {
      return yield* failTouchpoint("invalid-edits", `The plan needs input ${missingInput}`);
    }
    const attemptRun = yield* ledger.getRun(plan.attempt);
    return yield* buildWorkflowActionPlan({
      admission,
      document,
      operation,
      catalog: catalogResult.catalog,
      workspaces: registryState.workspaces,
      output: {
        summary: plan.summary,
        answers,
        inputs,
        ...(plan.workspace === null ? {} : { workspace: plan.workspace }),
      },
      attempt: plan.attempt,
      createdAtMillis,
      workflowRevision: plan.workflowRevision,
      ...pullRequestBuildInput(attemptRun?.branch ?? null),
    }).pipe(Effect.mapError((error) => touchpointFailure("invalid-edits", error.message)));
  });

  const recordDecision = Effect.fn("WorkflowRun.recordDecision")(function* (
    plan: WorkflowActionPlan,
    name: string,
    value: Readonly<Record<string, unknown>>,
  ) {
    const run = yield* ledger.getRun(plan.attempt);
    if (run === null) return;
    yield* recorder.record(run, {
      type: "CUSTOM",
      name,
      value: { object: value, raw: encodeDecision(value) },
    });
  });

  const finishTouchpointPlan = Effect.fn("WorkflowRun.finishTouchpointPlan")(function* (
    plan: WorkflowActionPlan,
    admission: TriggerAdmission,
    execution: WorkflowActionPlanExecution,
  ) {
    const { attempt, route } = completeActionPlanExecution(execution);
    if (attempt === null) return;
    yield* coordination.recordAttempt(admission.event.key, {
      operation: operationKeyOf(admission, plan.operation),
      outcome: attempt,
      lineage: admission.lineage,
    });
    if (RunCompletionRoute.$is("HandOff")(route)) {
      yield* executeAdmission(handOffAdmission(admission, route.node, plan.attempt));
      return;
    }
    yield* complete(admission);
  });

  const executeClaimedPlan = Effect.fn("WorkflowRun.executeClaimedPlan")(
    (plan: WorkflowActionPlan, admission: TriggerAdmission) =>
      Effect.acquireUseRelease(
        coordination.claim(admission.event.key, {
          operation: operationKeyOf(admission, plan.operation),
          lineage: admission.lineage,
        }),
        () => executeWorkflowActionPlan(plan, admission),
        (claim) => coordination.release(admission.event.key, claim).pipe(Effect.ignore),
      ),
  );

  return { currentPlan, rebuildPlan, recordDecision, finishTouchpointPlan, executeClaimedPlan };
});
