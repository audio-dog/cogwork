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
import { ContextAssembler } from "./context-assembler";
import { Coordination, maxLineageHops } from "./coordination";
import { Harness } from "./harness";
import { acceptOperationResult, harnessStreamFailed } from "./operation-result";
import { defaultRunBudget } from "./provider-runner";
import { WorkspaceRegistry } from "./registry";
import { RunLedger } from "./run-ledger";
import { subagentMembers } from "./run-plan";
import { harnessOptions, resolveRunPlan } from "./run-plan-resolution";
import { RunRecorder } from "./run-recorder";
import { SessionStore } from "./session-store";
import { type TriggerAdmission, TriggerObservation, TriggerObservationStore } from "./trigger-observation";
import { Recheck } from "./trigger-source";
import { Workflows } from "./workflow";
import { itemWorkspaceOf } from "./workflow-action-entry";
import { executeWorkflowActionPlan } from "./workflow-action-plan";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { WorkflowArtifactStore } from "./workflow-artifact-store";
import { handOffAdmission, operationKeyOf, parkedAdmission } from "./workflow-run-admission";
import { ClaimState, makeWorkflowRunAttempts } from "./workflow-run-attempts";
import { makeWorkflowRunExecutionContext } from "./workflow-run-execution-context";
import { touchpointFailure } from "./workflow-run-pending-plan";
import { engineToolsFor, makeWorkflowRunPreparation, selectedWorkspaceIds } from "./workflow-run-preparation";
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
  const sessions = yield* SessionStore;
  const ledger = yield* RunLedger;
  const recorder = yield* RunRecorder;
  const contextAssembler = yield* ContextAssembler;
  const actionPlans = yield* WorkflowActionPlanStore;
  const artifacts = yield* WorkflowArtifactStore;
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
  const { admittedSkills, prepareCheckout, preparationPark, runTools } = yield* makeWorkflowRunPreparation();
  const touchpointGate = Semaphore.makeUnsafe(1);

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
      registryState.workspaces.find(({ config }) => config.name === admission.event.workspace) ?? null;
    const outputWorkspaces = selectedWorkspaceIds(document, registryState.workspaces);
    const resultSchema = workflowOperationResultSchema(
      operation,
      catalogResult.catalog,
      outputWorkspaces,
      itemWorkspaceOf(admission),
    );
    const actionTools = engineToolsFor(operation, catalogResult.catalog);
    const selectedHarness = operation.model.harness ?? catalogResult.machine.defaultHarness;
    const hasMissingNeed = operation.requires.some(
      (need) => !catalogResult.machine.readyNeeds.includes(need),
    );
    if (selectedHarness === null || hasMissingNeed) return "waiting" as const;
    const preflight = yield* Effect.result(
      harness.preflight(
        selectedHarness,
        operation.permissionProfile,
        operation.model.model,
        harnessOptions(operation),
      ),
    );
    if (Result.isFailure(preflight)) return "waiting" as const;
    const projectedMembers = harness.projectedMembers(selectedHarness);
    const skills = yield* admittedSkills(workspace, operation.requires);
    const requiredSkill = skills.find(({ identity }) => operation.requires.some((need) => need === identity));
    const requiredSkillUnsupplied = requiredSkill !== undefined && !projectedMembers.includes("Skills");
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
    const coordinationView = yield* coordination.read(admission.event.key);
    const handback =
      coordinationView.handback !== null && coordinationView.handback.atMillis > admission.event.atMillis
        ? coordinationView.handback
        : null;
    const parkedAttempt = admission.lineage.parent === null ? null : RunId.make(admission.lineage.parent);
    const resumeReaders = [
      resumed === null ? null : () => ledger.getRun(resumed.plan.attempt),
      handback !== null && parkedAttempt !== null ? () => ledger.getRun(parkedAttempt) : null,
    ];
    const resumedRun = yield* resumeReaders.find((read) => read !== null)?.() ?? Effect.succeed(null);
    const resumedSession = resumedRun?.session ?? null;
    const prepared = yield* Effect.result(
      prepareCheckout(admission, workspace, operation.permissionProfile, resumedSession !== null),
    );
    if (Result.isFailure(prepared)) {
      const park = preparationPark(prepared.failure);
      return yield* refusePreparation(admission, claimed, preparing, prepared.failure.message, park);
    }
    const checkout = prepared.success;
    const session =
      resumedSession ??
      (yield* sessions.mint(
        { workspace: runWorkspace, harness: selectedHarness, createdAtMillis: startedAtMillis },
        harness.sessionKind,
      ));
    const priorIssues = (yield* Ref.get(previousResultIssues)).get(keyOf(admission.event.key)) ?? null;
    const assembled = yield* contextAssembler.assemble({
      runId: id,
      workspace: runWorkspace,
      cwd: checkout.path,
      projectRoot: checkout.path,
      operatingInstructions: operation,
      contributions: [],
    });
    yield* Effect.addFinalizer(() => contextAssembler.cleanup(id).pipe(Effect.ignore));
    const lineageArtifacts = yield* artifacts.byLineage(admission.lineage.root);
    const subagents = yield* subagentMembers(workspace?.contributions ?? [], operation.requires);
    const plan = resolveRunPlan({
      id,
      admission,
      workflow: record,
      operation,
      catalog: catalogResult.catalog,
      outputWorkspaces,
      harness: {
        name: selectedHarness,
        projectedMembers,
        middleware: harness.planMiddleware(selectedHarness),
        sessionKind: harness.sessionKind(selectedHarness),
      },
      workspaceCheckout: workspace === null ? null : checkout.path,
      instructions: assembled,
      previousResultIssues: priorIssues,
      lineageArtifacts,
      claim,
      handback,
      toolNeeds: actionTools,
      skills,
      subagents,
    });
    const run: RunRecord = {
      id,
      workspace: runWorkspace,
      workItem: workItemId(keyOf(admission.event.key)),
      ...(admission.event.subject ? { subject: admission.event.subject } : {}),
      workflow: record.id,
      operation: operation.id,
      harness: selectedHarness,
      branch: checkout.branch,
      session,
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

    const { engineTools, pullRequestSnapshots } = yield* runTools(
      actionTools,
      registryState.workspaces.filter(({ config }) => outputWorkspaces.includes(config.name)),
    );
    const eventsExit = yield* harness.run({ plan, session, mcpCredentials: new Map(), engineTools }).pipe(
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
        pullRequestSnapshots: yield* Ref.get(pullRequestSnapshots),
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
