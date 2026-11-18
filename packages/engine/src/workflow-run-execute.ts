import {
  type AgUiEvent,
  agUiIsStructuredOutputComplete,
  keyOf,
  RunId,
  type RunRecord,
  WorkflowActionPlan,
  WorkspaceId,
  workflowOperationResultSchema,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ContextAssembler } from "./context-assembler";
import { Coordination } from "./coordination";
import { Harness } from "./harness";
import { makeIssueSearchTool } from "./issue-search-tool";
import { IssueTracker } from "./issue-tracker";
import { acceptOperationResult, harnessStreamFailed } from "./operation-result";
import type { RegisteredWorkspace } from "./projector";
import { defaultRunBudget } from "./provider-runner";
import { makePullRequestTool } from "./pull-request-tool";
import { WorkspaceRegistry } from "./registry";
import { RunLedger } from "./run-ledger";
import { subagentMembers } from "./run-plan";
import { harnessOptions, resolveRunPlan } from "./run-plan-resolution";
import { RunRecorder } from "./run-recorder";
import { SessionStore } from "./session-store";
import { type PullRequestContext, SourceControlProvider } from "./source-control";
import { type TriggerAdmission, TriggerObservation, TriggerObservationStore } from "./trigger-observation";
import { Recheck } from "./trigger-source";
import { Workflows } from "./workflow";
import { itemWorkspaceOf } from "./workflow-action-entry";
import { buildWorkflowActionPlan, executeWorkflowActionPlan } from "./workflow-action-plan";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { actionEntryFor } from "./workflow-action-registry";
import { WorkflowArtifactStore } from "./workflow-artifact-store";
import {
  fanOutAdmission,
  handOffAdmission,
  operationKeyOf,
  resumedLineageParentOf,
} from "./workflow-run-admission";
import { type makeCheckout, workItemId } from "./workflow-run-checkout";
import { ClaimState, type makeClaim } from "./workflow-run-claim";
import type { makeAdmittedSkills } from "./workflow-run-skills";

const runId = Schema.decodeSync(RunId);
const workspaceId = Schema.decodeSync(WorkspaceId);
const encodeActionPlan = Schema.encodeSync(Schema.fromJsonString(WorkflowActionPlan));
const failedTerminal: AgUiEvent = { type: "RUN_FINISHED", finishReason: "failed" };
const engineToolsFor = (
  operation: Parameters<typeof workflowOperationResultSchema>[0],
  catalog: Parameters<typeof workflowOperationResultSchema>[1],
) => {
  const actionKeys = new Set(catalog.entries.filter(({ kind }) => kind === "action").map(({ key }) => key));
  return new Set(
    operation.transitions
      .flatMap(({ actions }) => actions)
      .filter(({ entry }) => actionKeys.has(entry))
      .flatMap(({ entry }) => actionEntryFor(entry)?.tools ?? []),
  );
};

const resumedPlanHaltOutcome = {
  Retry: "retry",
  Parked: "completed",
  AwaitingApproval: "completed",
  HandedToYou: "completed",
} as const;

const selectedWorkspaceIds = (
  document: Parameters<typeof buildWorkflowActionPlan>[0]["document"],
  workspaces: ReadonlyArray<RegisteredWorkspace>,
) => {
  const registered = workspaces.map(({ config }) => config.name);
  return document.workspaces._tag === "Every"
    ? registered
    : document.workspaces.workspaces.filter((workspace) => registered.includes(workspace));
};

export const makeExecute = ({
  admittedSkills,
  claimItem,
  closeRevision,
  complete,
  parkCappedLineage,
  parkClaimed,
  prepareCheckout,
  previousResultIssues,
  pullRequestBuildInput,
  recordClaimedAttempt,
  refusePlan,
  refusePreparation,
  refuseResult,
  rejectPlan,
  settleClaimed,
  skipNoLongerMatching,
}: Effect.Success<ReturnType<typeof makeClaim>> &
  Effect.Success<ReturnType<typeof makeCheckout>> & {
    readonly admittedSkills: Effect.Success<typeof makeAdmittedSkills>;
    readonly previousResultIssues: Ref.Ref<ReadonlyMap<string, string>>;
  }) =>
  Effect.gen(function* () {
    const workflows = yield* Workflows;
    const coordination = yield* Coordination;
    const harness = yield* Harness;
    const sessions = yield* SessionStore;
    const ledger = yield* RunLedger;
    const recorder = yield* RunRecorder;
    const contextAssembler = yield* ContextAssembler;
    const actionPlans = yield* WorkflowActionPlanStore;
    const artifacts = yield* WorkflowArtifactStore;
    const issueTracker = yield* IssueTracker;
    const registry = yield* WorkspaceRegistry;
    const sourceControl = Option.getOrNull(yield* Effect.serviceOption(SourceControlProvider));
    const observationStore = yield* TriggerObservationStore;
    const triggerObservation = yield* TriggerObservation;

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
      const issueSearchEnabled = actionTools.has("issue-search");
      const pullRequestToolEnabled = actionTools.has("pull-request");
      const toolWorkspaces = registryState.workspaces.filter(({ config }) =>
        outputWorkspaces.includes(config.name),
      );
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
      const requiredSkill = skills.find(({ identity }) =>
        operation.requires.some((need) => need === identity),
      );
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
        return yield* refusePreparation(admission, claimed, preparing, prepared.failure);
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

      const pullRequestSnapshots = yield* Ref.make<
        ReadonlyArray<{ readonly workspace: string; readonly pullRequest: PullRequestContext }>
      >([]);
      const engineTools = [
        ...(issueSearchEnabled ? [makeIssueSearchTool(issueTracker, toolWorkspaces)] : []),
        ...(pullRequestToolEnabled && sourceControl
          ? [
              makePullRequestTool(sourceControl, toolWorkspaces, (selected, pullRequest) =>
                Ref.update(pullRequestSnapshots, (snapshots) => [
                  ...snapshots,
                  { workspace: selected.config.name, pullRequest },
                ]),
              ),
            ]
          : []),
      ];
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
      if (Result.isFailure(decoded))
        return yield* refuseResult(admission, claimed, accepted, decoded.failure);

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
        yield* parkClaimed(admission, accepted, { _tag: "Stuck", summary: decoded.success.summary });
        yield* settleClaimed(claimed, "failed");
        return "completed" as const;
      }

      const reviewedPullRequests = yield* Ref.get(pullRequestSnapshots);

      if ("elements" in decoded.success) {
        const children = decoded.success.elements.map((element, position) => ({
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
            admission: child,
            document,
            operation,
            catalog: catalogResult.catalog,
            workspaces: registryState.workspaces,
            output: element,
            attempt: run.id,
            createdAtMillis: startedAtMillis,
            workflowRevision: record.publishedRevision ?? record.workingRevision,
            ...pullRequestBuildInput(run.branch),
            pullRequestSnapshots: reviewedPullRequests,
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
          admission,
          document,
          operation,
          catalog: catalogResult.catalog,
          workspaces: registryState.workspaces,
          output: decoded.success,
          attempt: run.id,
          createdAtMillis: yield* Clock.currentTimeMillis,
          workflowRevision: record.publishedRevision ?? record.workingRevision,
          ...pullRequestBuildInput(run.branch),
          pullRequestSnapshots: reviewedPullRequests,
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
      const execution = yield* executeWorkflowActionPlan(actionPlan, admission);
      if (execution._tag === "Replan") {
        yield* settleClaimed(claimed, "interrupted");
        return admission;
      }
      if (execution._tag !== "Complete") {
        const status =
          execution._tag === "AwaitingApproval" || execution._tag === "HandedToYou" ? "succeeded" : "failed";
        yield* settleClaimed(claimed, status);
        return execution._tag === "Retry" ? ("retry" as const) : ("completed" as const);
      }
      yield* recordClaimedAttempt(admission, claimed, accepted, { outcome: "succeeded" });
      yield* settleClaimed(claimed, "succeeded");
      if (execution.handOff !== null) {
        return handOffAdmission(admission, execution.handOff, run.id);
      }
      yield* complete(admission);
      return "completed" as const;
    });

    return { executeRaw };
  });
