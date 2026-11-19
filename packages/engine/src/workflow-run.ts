import {
  type AgUiEvent,
  agUiIsStructuredOutputComplete,
  keyOf,
  RunId,
  type RunRecord,
  type WorkflowActionPlan,
  WorkflowTouchpointFailure,
  WorkItemId,
  WorkspaceId,
  workflowOperationResultSchema,
} from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { Coordination, maxLineageHops } from "./coordination";
import { Harness } from "./harness";
import { acceptOperationResult, harnessStreamFailed } from "./operation-result";
import { defaultRunBudget } from "./provider-runner";
import { WorkspaceRegistry } from "./registry-service";
import { RunLedger } from "./run-ledger";
import {
  type RunPlanRejection,
  RunPlanResolution,
  readyHarness,
  resolveRunPlan,
} from "./run-plan-resolution";
import { CheckoutRefused, make as makeRunPreparation, selectedWorkspaceIds } from "./run-preparation";
import { RunRecorder } from "./run-recorder";
import { TriggerObservation } from "./trigger-observation";
import type { TriggerAdmission } from "./trigger-observation-admission";
import { TriggerObservationStore } from "./trigger-observation-store";
import { Recheck } from "./trigger-source";
import { Workflows } from "./workflow";
import { itemWorkspaceOf } from "./workflow-action-entry";
import { executeWorkflowActionPlan } from "./workflow-action-plan";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { handOffAdmission, operationKeyOf, parkedAdmission } from "./workflow-run-admission";
import { ClaimState, makeWorkflowRunAttempts } from "./workflow-run-attempts";
import { make as makeRunEngineTools } from "./workflow-run-engine-tools";
import { makeWorkflowRunExecutionContext } from "./workflow-run-execution-context";
import { touchpointFailure } from "./workflow-run-pending-plan";
import { makeWorkflowRunTouchpoints } from "./workflow-run-touchpoints";

const runId = Schema.decodeSync(RunId);
const workspaceId = Schema.decodeSync(WorkspaceId);
const workItemId = Schema.decodeSync(WorkItemId);
const failedTerminal: AgUiEvent = { type: "RUN_FINISHED", finishReason: "failed" };

export type WorkflowRunOutcome = "completed" | "retry" | "skipped" | "waiting";

interface AdmissionExecutionState {
  readonly current: TriggerAdmission | null;
  readonly outcome: WorkflowRunOutcome;
}

const resumedPlanHaltOutcome = {
  Retry: "retry",
  Parked: "completed",
  AwaitingApproval: "completed",
  HandedToYou: "completed",
} as const;

const resumedLineageParentOf = (admission: TriggerAdmission, plan: WorkflowActionPlan) =>
  admission.event.key._tag === "FanOutChild" ? null : plan.attempt;

export const make = Effect.gen(function* () {
  const workflows = yield* Workflows;
  const coordination = yield* Coordination;
  const harness = yield* Harness;
  const ledger = yield* RunLedger;
  const recorder = yield* RunRecorder;
  const actionPlans = yield* WorkflowActionPlanStore;
  const registry = yield* WorkspaceRegistry;
  const observationStore = yield* TriggerObservationStore;
  const triggerObservation = yield* TriggerObservation;
  const { executionContext, pullRequestBuildInput } = yield* makeWorkflowRunExecutionContext();
  const {
    previousResultIssues,
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
    actOnResult,
  } = yield* makeWorkflowRunAttempts(pullRequestBuildInput);
  const preparation = yield* makeRunPreparation;
  const runEngineTools = yield* makeRunEngineTools;
  const touchpointGate = Semaphore.makeUnsafe(1);

  const declineRun = (reason: RunPlanRejection) =>
    Effect.logDebug("Run Plan rejected", { reason }).pipe(Effect.map(() => "waiting" as const));

  const executeRaw = Effect.fn("WorkflowRun.execute")(function* (
    admission: TriggerAdmission,
    claimed: Ref.Ref<ClaimState>,
  ) {
    const pendingPlan = yield* actionPlans.pending(
      keyOf(admission.event.key),
      admission.subscription.workflow,
    );
    const stalePlan = pendingPlan !== null && pendingPlan.revision !== admission.event.revision;
    const operationId =
      pendingPlan?.revision === admission.event.revision
        ? pendingPlan.operation
        : admission.subscription.operation;
    if (stalePlan) {
      yield* actionPlans.remove(pendingPlan.item, pendingPlan.workflow, pendingPlan.attempt);
    }
    const resumesPendingPlan = pendingPlan !== null && !stalePlan;
    const resumed = resumesPendingPlan
      ? {
          plan: pendingPlan,
          work: ClaimState.Claimed({
            key: operationKeyOf(admission, pendingPlan.operation),
            run: null,
            lineageParent: resumedLineageParentOf(admission, pendingPlan),
          }),
        }
      : null;
    const pendingClaim = resumed === null ? null : yield* claimItem(admission, claimed, resumed.work);
    if (resumed !== null) {
      if (yield* parkCappedLineage(admission, resumed.work.key)) return "completed" as const;
      const execution = yield* executeWorkflowActionPlan(resumed.plan, admission);
      if (execution._tag === "Replan") {
        yield* settleClaimed(claimed, "interrupted");
      }
      if (execution._tag !== "Replan" && execution._tag !== "Complete") {
        return resumedPlanHaltOutcome[execution._tag];
      }
      if (execution._tag === "Complete") {
        yield* recordClaimedAttempt(admission, claimed, resumed.work, { outcome: "succeeded" });
        if (execution.handOff !== null) {
          return handOffAdmission(admission, execution.handOff, resumed.plan.attempt);
        }
        yield* complete(admission);
        return "completed" as const;
      }
    }

    const record = yield* workflows.get({ id: admission.subscription.workflow });
    const document = record.publishedCopy;
    const hasTrigger = document?.triggers.some(({ id }) => id === admission.subscription.trigger);
    const operation = document?.operations.find(({ id }) => id === operationId);
    if (!record.enabled || document === null || !hasTrigger || operation === undefined) {
      yield* complete(admission);
      return "skipped" as const;
    }
    if (admission.event.payload?._tag === "GranolaNoteRejected") {
      return yield* rejectPlan(admission, admission.event.payload.reason);
    }
    const current = yield* triggerObservation.recheck(admission);
    if (Recheck.$is("Ended")(current)) return yield* skipNoLongerMatching(admission, current.reason);
    if (Recheck.$is("Waiting")(current)) return "waiting" as const;

    const key = operationKeyOf(admission, operation.id);
    const catalogResult = yield* workflows.catalog;
    const registryState = yield* registry.state;
    const workspace =
      registryState.workspaces.find(({ config }) => config.id === admission.event.workspace) ?? null;
    const outputWorkspaces = selectedWorkspaceIds(document, registryState.workspaces);
    const resultSchema = workflowOperationResultSchema(
      operation,
      catalogResult.catalog,
      outputWorkspaces,
      itemWorkspaceOf(admission),
    );
    const toolWorkspaces = registryState.workspaces.filter(({ config }) =>
      outputWorkspaces.includes(config.id),
    );
    const preflight = yield* preparation.preflight(operation, catalogResult.machine);
    const ready = readyHarness(preflight);
    if (Result.isFailure(ready)) return yield* declineRun(ready.failure);
    const selectedHarness = ready.success.name;
    const skills = yield* preparation.admittedSkills(workspace, operation.requires);
    const requiredSkill = skills.find(({ identity }) => operation.requires.some((need) => need === identity));
    const requiredSkillUnsupplied =
      requiredSkill !== undefined && !ready.success.projectedMembers.includes("Skills");
    if (requiredSkillUnsupplied) {
      return yield* rejectPlan(
        admission,
        `${selectedHarness} does not project Skills, so it cannot supply the required Skill ${requiredSkill.identity}`,
      );
    }

    const preparing = ClaimState.Claimed({ key, run: null, lineageParent: null });
    const claim = pendingClaim ?? (yield* claimItem(admission, claimed, preparing));
    if (yield* parkCappedLineage(admission, key)) return "completed" as const;
    const startedAtMillis = yield* Clock.currentTimeMillis;
    const id = runId(SecureRandom.uuidV4Unsafe());
    const runWorkspace = admission.event.workspace ?? workspaceId(admission.subscription.workflow);
    const prepared = yield* preparation
      .prepare({
        admission,
        workspace,
        operation,
        harness: selectedHarness,
        run: { id, workspace: runWorkspace, startedAtMillis },
        pendingPlanAttempt: resumed?.plan.attempt ?? null,
      })
      .pipe(Effect.catchTag("CheckoutRefused", Effect.succeed));
    if (prepared instanceof CheckoutRefused) {
      return yield* refusePreparation(admission, claimed, preparing, prepared.message, prepared.park);
    }
    const resolution = resolveRunPlan({
      id,
      operation,
      harness: preflight,
      admission,
      workflow: record,
      catalog: catalogResult.catalog,
      outputWorkspaces,
      workspaceCheckout: workspace === null ? null : prepared.checkout.path,
      instructions: prepared.instructions,
      previousResultIssues: (yield* Ref.get(previousResultIssues)).get(keyOf(admission.event.key)) ?? null,
      lineageArtifacts: prepared.lineageArtifacts,
      claim,
      handback: prepared.handback,
      skills,
      subagents: prepared.subagents,
    });
    if (RunPlanResolution.$is("Rejected")(resolution)) return yield* declineRun(resolution.reason);
    const { plan, toolNeeds } = resolution;
    const run: RunRecord = {
      id,
      workspace: runWorkspace,
      workItem: workItemId(keyOf(admission.event.key)),
      ...(admission.event.subject ? { subject: admission.event.subject } : {}),
      workflow: record.id,
      operation: operation.id,
      harness: selectedHarness,
      branch: prepared.checkout.branch,
      session: prepared.session,
      usage: null,
      status: "running",
      startedAtMillis,
      endedAtMillis: null,
    };
    const accepted = ClaimState.Claimed({ key, run: id, lineageParent: id });
    yield* Ref.set(claimed, accepted).pipe(
      Effect.andThen(ledger.acceptRun(run, plan)),
      Effect.uninterruptible,
    );

    const engineTools = yield* runEngineTools(toolNeeds, toolWorkspaces);
    const eventsExit = yield* harness
      .run({ plan, session: prepared.session, mcpCredentials: new Map(), engineTools: engineTools.tools })
      .pipe(
        Stream.tap((event) => recorder.record(run, event)),
        Stream.filter(agUiIsStructuredOutputComplete),
        Stream.runLast,
        Effect.timeout(defaultRunBudget(operation.permissionProfile)),
        Effect.exit,
      );
    if (Exit.isFailure(eventsExit)) {
      yield* recorder.record(run, failedTerminal);
      return yield* refuseResult(admission, claimed, accepted, harnessStreamFailed(eventsExit.cause));
    }

    const decoded = acceptOperationResult({
      event: Option.getOrUndefined(eventsExit.value),
      schema: resultSchema,
      capabilities: harness.capabilities(selectedHarness),
    });
    if (Result.isFailure(decoded)) return yield* refuseResult(admission, claimed, accepted, decoded.failure);

    yield* Ref.update(previousResultIssues, (current) => {
      const next = new Map(current);
      next.delete(keyOf(admission.event.key));
      return next;
    });
    if (decoded.success.stuck) {
      yield* recordClaimedAttempt(admission, claimed, accepted, {
        outcome: "failed",
        reason: decoded.success.summary,
      });
      yield* coordination.park(admission.event.key, { _tag: "Stuck", summary: decoded.success.summary }, key);
      yield* observationStore.putAll([parkedAdmission(admission, run.id)]);
      yield* settleClaimed(claimed, "failed");
      return "completed" as const;
    }

    return yield* actOnResult({
      admission,
      claimed,
      accepted,
      run,
      output: decoded.success,
      startedAtMillis,
      plan: {
        document,
        operation,
        catalog: catalogResult.catalog,
        workspaces: registryState.workspaces,
        workflowRevision: record.publishedRevision ?? record.workingRevision,
        pullRequestSnapshots: yield* engineTools.reviewedPullRequests,
      },
    });
  });

  const executeToOutcome = Effect.fn("WorkflowRun.executeToOutcome")(function* (admission: TriggerAdmission) {
    const claimed = yield* Ref.make<ClaimState>(ClaimState.Idle());
    return yield* executeRaw(admission, claimed).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => recoverClaimed(admission, claimed, cause),
      ),
      Effect.onInterrupt(() =>
        Effect.flatMap(Ref.get(claimed), (state) =>
          settleClaimed(claimed, ClaimState.$is("Attempted")(state) ? state.status : "interrupted"),
        ),
      ),
    );
  });

  const executeAdmission = (admission: TriggerAdmission) =>
    observationStore.admissions.pipe(
      Effect.map(
        (admissions) =>
          admissions.find(
            (candidate) =>
              keyOf(candidate.event.key) === keyOf(admission.event.key) &&
              candidate.event.revision === admission.event.revision &&
              candidate.subscription.workflow === admission.subscription.workflow &&
              candidate.subscription.trigger === admission.subscription.trigger,
          ) ?? admission,
      ),
      Effect.flatMap((current) =>
        Effect.reduce(
          Array.from({ length: maxLineageHops + 1 }),
          (): AdmissionExecutionState => ({ current, outcome: "completed" }),
          (state) => {
            if (state.current === null) return Effect.succeed(state);
            return executeToOutcome(state.current).pipe(
              Effect.scoped,
              Effect.flatMap((next) => {
                if (typeof next === "string") {
                  return Effect.succeed<AdmissionExecutionState>({ current: null, outcome: next });
                }
                return observationStore
                  .putAll([next])
                  .pipe(
                    Effect.map((): AdmissionExecutionState => ({ current: next, outcome: state.outcome })),
                  );
              }),
            );
          },
        ),
      ),
      Effect.provide(executionContext),
      Effect.map(({ outcome }) => outcome),
    );

  const touchpoints = yield* makeWorkflowRunTouchpoints({
    complete,
    executeAdmission,
    pullRequestBuildInput,
  });

  const touchpoint = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((error) =>
        Schema.is(WorkflowTouchpointFailure)(error)
          ? error
          : touchpointFailure("unavailable", error instanceof Error ? error.message : String(error)),
      ),
    );

  const runTouchpoint = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    touchpointGate.withPermit(touchpoint(effect).pipe(Effect.provide(executionContext)));

  return {
    execute: executeAdmission,
    refreshReviewPlans: () => touchpointGate.withPermit(touchpoints.refreshReviewPlans()),
    approve: (payload: Parameters<typeof touchpoints.approve>[0]) =>
      runTouchpoint(touchpoints.approve(payload)),
    reject: (payload: Parameters<typeof touchpoints.reject>[0]) => runTouchpoint(touchpoints.reject(payload)),
    chooseAnswer: (payload: Parameters<typeof touchpoints.chooseAnswer>[0]) =>
      runTouchpoint(touchpoints.chooseAnswer(payload)),
    handBack: (payload: Parameters<typeof touchpoints.handBack>[0]) =>
      runTouchpoint(touchpoints.handBack(payload)),
  } as const;
});

export const WorkflowRun = Context.Reference<Effect.Success<typeof make>>(
  "@cogwork/engine/workflow-run/WorkflowRun",
  {
    defaultValue: () => ({
      execute: () => Effect.succeed("completed" as const),
      refreshReviewPlans: () => Effect.void,
      approve: () =>
        Effect.fail(new WorkflowTouchpointFailure({ reason: "unavailable", message: "unavailable" })),
      reject: () =>
        Effect.fail(new WorkflowTouchpointFailure({ reason: "unavailable", message: "unavailable" })),
      chooseAnswer: () =>
        Effect.fail(new WorkflowTouchpointFailure({ reason: "unavailable", message: "unavailable" })),
      handBack: () =>
        Effect.fail(new WorkflowTouchpointFailure({ reason: "unavailable", message: "unavailable" })),
    }),
  },
);

export const layer = Layer.effect(WorkflowRun, make);
