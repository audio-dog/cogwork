import { randomUUID } from "node:crypto";
import {
  type AgUiEvent,
  agUiIsStructuredOutputComplete,
  keyOf,
  LineageId,
  Principal,
  RunId,
  RunPlan,
  type RunRecord,
  WorkflowActionPlan,
  WorkflowActionPlanStep,
  WorkflowTouchpointFailure,
  WorkItemId,
  type WorkItemRef,
  WorkspaceId,
  workflowOperationResultJsonSchema,
  workflowOperationResultSchema,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ContextAssembler } from "./context-assembler";
import { Coordination, maxLineageHops } from "./coordination";
import { Harness, type HarnessRunnerEnv } from "./harness";
import { IssueTracker } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { defaultRunBudget } from "./provider-runner";
import { WorkspaceRegistry } from "./registry";
import { RunLedger } from "./run-ledger";
import { RunRecorder } from "./run-recorder";
import { SessionStore } from "./session-store";
import { type TriggerAdmission, TriggerObservationStore } from "./trigger-observation";
import { Workflows } from "./workflow";
import {
  buildWorkflowActionPlan,
  executeWorkflowActionPlan,
  type WorkflowActionPlanExecution,
} from "./workflow-action-plan";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { WorkflowNotifications } from "./workflow-notification";

const runId = Schema.decodeSync(RunId);
const workspaceId = Schema.decodeSync(WorkspaceId);
const workItemId = Schema.decodeSync(WorkItemId);
const encodeActionPlan = Schema.encodeSync(Schema.fromJsonString(WorkflowActionPlan));
const encodeDecision = Schema.encodeSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)));
const failedTerminal: AgUiEvent = { type: "RUN_FINISHED", finishReason: "failed" };

export type WorkflowRunOutcome = "completed" | "retry" | "skipped";

const workContextBody = (admission: TriggerAdmission, workflow: string) => {
  const payload = admission.event.payload;
  if (payload?._tag !== "GranolaNote") {
    return `Scheduled instant ${admission.event.revision} for Workflow ${workflow}.`;
  }
  return [
    `# ${payload.title}`,
    "",
    "## Attendees",
    payload.attendees.join("\n"),
    "",
    "## Calendar event",
    payload.calendarEvent,
    "",
    "## Summary",
    payload.summary,
    "",
    "## Transcript",
    payload.transcript,
  ].join("\n");
};

const operationKeyOf = (admission: TriggerAdmission, operation: string) => ({
  workflow: admission.subscription.workflow,
  operation,
});

const handOffAdmission = (
  admission: TriggerAdmission,
  operation: TriggerAdmission["subscription"]["operation"],
  attempt: RunId,
) => ({
  ...admission,
  subscription: { ...admission.subscription, operation },
  lineage: {
    root: admission.lineage.root,
    parent: LineageId.make(attempt),
    hop: admission.lineage.hop + 1,
  },
});

const initialAdmission = (admission: TriggerAdmission) => admission as TriggerAdmission | null;

const selectedWorkspaceIds = (
  document: Parameters<typeof buildWorkflowActionPlan>[0]["document"],
  workspaces: ReadonlyArray<RegisteredWorkspace>,
) => {
  const registered = workspaces.map(({ config }) => config.name);
  return document.workspaces._tag === "Every"
    ? registered
    : document.workspaces.workspaces.filter((workspace) => registered.includes(workspace));
};

const projection = [
  "Harness Adapter",
  "Instructions",
  "Messages",
  "Work Context",
  "Middleware",
  "Sandbox",
  "Structured Output",
  "Persistence",
  "Provenance",
].map((member) => ({ member, disposition: "projected" as const }));

export const make = Effect.gen(function* () {
  const workflows = yield* Workflows;
  const coordination = yield* Coordination;
  const harness = yield* Harness;
  const sessions = yield* SessionStore;
  const ledger = yield* RunLedger;
  const recorder = yield* RunRecorder;
  const contextAssembler = yield* ContextAssembler;
  const notifications = yield* WorkflowNotifications;
  const actionPlans = yield* WorkflowActionPlanStore;
  const issueTracker = yield* IssueTracker;
  const registry = yield* WorkspaceRegistry;
  const observationStore = yield* TriggerObservationStore;
  const executionContext = yield* Effect.context<HarnessRunnerEnv>().pipe(
    Effect.map((context) =>
      context.pipe(
        Context.add(Coordination, coordination),
        Context.add(IssueTracker, issueTracker),
        Context.add(RunLedger, ledger),
        Context.add(WorkflowActionPlanStore, actionPlans),
        Context.add(WorkflowNotifications, notifications),
        Context.add(TriggerObservationStore, observationStore),
      ),
    ),
  );
  const decodeIssues = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

  const settle = (record: RunRecord, status: RunRecord["status"]) =>
    Effect.flatMap(Clock.currentTimeMillis, (endedAtMillis) =>
      ledger.updateRun(record.id, { status, usage: null, endedAtMillis }),
    );

  const settleAttempt = (attempt: RunId, status: RunRecord["status"]) =>
    Effect.flatMap(Clock.currentTimeMillis, (endedAtMillis) =>
      ledger.updateRun(attempt, { status, usage: null, endedAtMillis }),
    );

  const complete = Effect.fn("WorkflowRun.complete")(function* (admission: TriggerAdmission) {
    yield* observationStore.complete(
      admission,
      coordination.markProcessed(admission.event.key, admission.event.revision),
    );
  });

  const decline = (admission: TriggerAdmission) =>
    coordination
      .park(
        admission.event.key,
        { _tag: "MissingOperation" },
        operationKeyOf(admission, admission.subscription.operation),
      )
      .pipe(Effect.map(() => "skipped" as const));

  const rejectPlan = (admission: TriggerAdmission, reason: string) =>
    coordination
      .park(admission.event.key, { _tag: "PlanRejected", reason, entry: admission.event.entry })
      .pipe(
        Effect.andThen(complete(admission)),
        Effect.map(() => "skipped" as const),
      );

  const refuseResult = Effect.fn("WorkflowRun.refuseResult")(function* (
    admission: TriggerAdmission,
    key: ReturnType<typeof operationKeyOf>,
    run: RunRecord,
    issues: string,
  ) {
    yield* Ref.update(decodeIssues, (current) => new Map(current).set(keyOf(admission.event.key), issues));
    const view = yield* coordination.recordAttempt(admission.event.key, {
      operation: key,
      outcome: "failed",
      lineage: admission.lineage,
      reason: issues,
    });
    const exhausted = view.counters(key).exhausted;
    yield* settle(run, exhausted ? "exhausted" : "failed");
    if (!exhausted) return "retry" as const;
    yield* coordination.park(admission.event.key, { _tag: "Exhausted", reason: issues }, key);
    return "completed" as const;
  });

  const executeRaw = Effect.fn("WorkflowRun.execute")(function* (admission: TriggerAdmission) {
    if (admission.lineage.hop >= maxLineageHops) {
      yield* coordination.park(admission.event.key, { _tag: "HopCap" });
      return "completed" as const;
    }
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
      yield* settleAttempt(pendingPlan.attempt, "interrupted");
      yield* actionPlans.remove(pendingPlan.item, pendingPlan.workflow, pendingPlan.attempt);
    }
    const pendingKey =
      pendingPlan !== null && !stalePlan ? operationKeyOf(admission, pendingPlan.operation) : null;
    const pendingClaim =
      pendingKey === null
        ? null
        : yield* Effect.acquireRelease(
            coordination.claim(admission.event.key, {
              operation: pendingKey,
              lineage: admission.lineage,
            }),
            (activeClaim) =>
              coordination
                .release(admission.event.key, activeClaim)
                .pipe(Effect.catch((error) => Effect.logError("Workflow Claim release failed", { error }))),
          );
    if (pendingPlan !== null && pendingKey !== null) {
      const execution = yield* executeWorkflowActionPlan(pendingPlan, admission);
      if (execution._tag === "Replan") {
        yield* settleAttempt(pendingPlan.attempt, "interrupted");
      }
      if (execution._tag === "Retry" || execution._tag === "Parked") {
        yield* settleAttempt(pendingPlan.attempt, "failed");
        return execution._tag === "Retry" ? ("retry" as const) : ("completed" as const);
      }
      if (execution._tag === "AwaitingApproval" || execution._tag === "HandedToYou") {
        yield* settleAttempt(pendingPlan.attempt, "succeeded");
        return "completed" as const;
      }
      if (execution._tag === "Complete") {
        yield* coordination.recordAttempt(admission.event.key, {
          operation: pendingKey,
          outcome: "succeeded",
          lineage: admission.lineage,
        });
        yield* settleAttempt(pendingPlan.attempt, "succeeded");
        if (execution.handOff !== null) {
          return handOffAdmission(admission, execution.handOff, pendingPlan.attempt);
        }
        yield* complete(admission);
        return "completed" as const;
      }
    }

    const record = yield* workflows.get({ id: admission.subscription.workflow });
    const document = record.publishedCopy;
    const trigger = document?.triggers.find(({ id }) => id === admission.subscription.trigger);
    const operation = document?.operations.find(({ id }) => id === operationId);
    if (!record.enabled || document === null || trigger === undefined || operation === undefined) {
      yield* complete(admission);
      return "skipped" as const;
    }
    if (admission.event.payload?._tag === "GranolaNoteRejected") {
      return yield* rejectPlan(admission, admission.event.payload.reason);
    }

    const key = operationKeyOf(admission, operation.id);
    const catalogResult = yield* workflows.catalog;
    const registryState = yield* registry.state;
    const outputWorkspaces = selectedWorkspaceIds(document, registryState.workspaces);
    const selectedHarness = operation.model.harness ?? catalogResult.machine.defaultHarness;
    const hasMissingNeed = operation.requires.some(
      (need) => !catalogResult.machine.readyNeeds.includes(need),
    );
    if (selectedHarness === null || hasMissingNeed) return yield* decline(admission);
    const options = Object.fromEntries(operation.model.options.map(({ id, value }) => [id, value]));
    const preflight = yield* Effect.result(
      harness.preflight(selectedHarness, operation.permissionProfile, operation.model.model, options),
    );
    if (Result.isFailure(preflight)) return yield* decline(admission);

    const claim =
      pendingClaim ??
      (yield* Effect.acquireRelease(
        coordination.claim(admission.event.key, { operation: key, lineage: admission.lineage }),
        (activeClaim) =>
          coordination
            .release(admission.event.key, activeClaim)
            .pipe(Effect.catch((error) => Effect.logError("Workflow Claim release failed", { error }))),
      ));
    const startedAtMillis = yield* Clock.currentTimeMillis;
    const id = runId(randomUUID());
    const workspace = admission.event.workspace ?? workspaceId(admission.subscription.workflow);
    const item = workItemId(keyOf(admission.event.key));
    const coordinationView = yield* coordination.read(admission.event.key);
    const handback =
      coordinationView.handback !== null && coordinationView.handback.atMillis > admission.event.atMillis
        ? coordinationView.handback
        : null;
    const resumeReaders = [
      pendingPlan !== null && !stalePlan ? () => ledger.getRun(pendingPlan.attempt) : null,
      handback !== null ? () => ledger.latestRunForItem(workspace, item) : null,
    ];
    const resumedRun = yield* resumeReaders.find((read) => read !== null)?.() ?? Effect.succeed(null);
    const session =
      resumedRun?.session ??
      (yield* sessions.mint(
        { workspace, harness: selectedHarness, createdAtMillis: startedAtMillis },
        harness.sessionKind,
      ));
    const handbackNote = handback?.note?.trim();
    const priorIssues = (yield* Ref.get(decodeIssues)).get(keyOf(admission.event.key)) ?? null;
    const assembled = yield* contextAssembler.assemble({
      runId: id,
      workspace,
      cwd: "/",
      projectRoot: "/",
      operatingInstructions: operation,
      contributions: [],
    });
    yield* Effect.addFinalizer(() => contextAssembler.cleanup(id).pipe(Effect.ignore));
    const observation = {
      generation: record.publishedRevision ?? 0,
      observedAtMillis: admission.event.atMillis,
    };
    const plan = RunPlan.make({
      id,
      operation: "implement",
      harness: {
        name: selectedHarness,
        model: operation.model.model,
        options,
        profile: operation.permissionProfile,
      },
      instructions: assembled.layers,
      operatingInstructions: {
        name: assembled.operatingInstructionsName,
        path: assembled.operatingInstructionsPath,
        resources: [
          ...assembled.operatingInstructionResources,
          ...(priorIssues === null ? [] : [{ source: "previous-result-issues", content: priorIssues }]),
        ],
      },
      messages: [
        {
          role: "user",
          content: handbackNote
            ? `Run Workflow Operation: ${operation.name}\n\nPerson's note: ${handbackNote}`
            : `Run Workflow Operation: ${operation.name}`,
        },
      ],
      tools: [],
      skills: [],
      mcp: [],
      subagents: [],
      commands: [],
      hooks: [],
      middleware: [...harness.planMiddleware(selectedHarness)],
      structuredOutput: workflowOperationResultJsonSchema(operation, catalogResult.catalog, outputWorkspaces)[
        "~standard"
      ].jsonSchema.input({ target: "draft-2020-12" }),
      connections: [],
      workContext: {
        reference: { workItem: item, url: null },
        facts: { roles: [], assignees: [], openBlockers: 0, claim, priority: "medium", pr: null },
        prose: admission.event.workContext ?? {
          body: workContextBody(admission, record.id),
          comments: [],
        },
        observation,
      },
      sandbox: { workspace: null, policy: operation.permissionProfile },
      persistence: { sessionKind: harness.sessionKind(selectedHarness) },
      provenance: {
        resolution: [],
        stamps: [],
        projectedNames: [],
        projection,
        observation,
      },
    });
    const run: RunRecord = {
      id,
      workspace,
      workItem: item,
      stage: "implement",
      harness: selectedHarness,
      branch: null,
      session,
      usage: null,
      status: "running",
      startedAtMillis,
      endedAtMillis: null,
    };
    yield* ledger.acceptRun(run, plan);

    const eventsExit = yield* harness.run({ plan, session, mcpCredentials: new Map() }).pipe(
      Stream.tap((event) => recorder.record(run, event)),
      Stream.filter(agUiIsStructuredOutputComplete),
      Stream.runLast,
      Effect.timeout(defaultRunBudget(operation.permissionProfile)),
      Effect.exit,
    );
    if (Exit.isFailure(eventsExit)) {
      const reason = String(eventsExit.cause);
      yield* recorder.record(run, failedTerminal);
      const view = yield* coordination.recordAttempt(admission.event.key, {
        operation: key,
        outcome: "failed",
        lineage: admission.lineage,
        reason,
      });
      const exhausted = view.counters(key).exhausted;
      yield* settle(run, exhausted ? "exhausted" : "failed");
      if (exhausted) {
        yield* coordination.park(admission.event.key, { _tag: "Exhausted", reason }, key);
      }
      return exhausted ? ("completed" as const) : ("retry" as const);
    }

    const output = Option.getOrUndefined(eventsExit.value);
    const decoded = Schema.decodeUnknownExit(
      workflowOperationResultSchema(operation, catalogResult.catalog, outputWorkspaces),
    )(output?.value.object);
    if (Exit.isFailure(decoded)) {
      const issues = String(decoded.cause);
      return yield* refuseResult(admission, key, run, issues);
    }

    yield* Ref.update(decodeIssues, (current) => {
      const next = new Map(current);
      next.delete(keyOf(admission.event.key));
      return next;
    });
    if (decoded.value.stuck) {
      yield* coordination.recordAttempt(admission.event.key, {
        operation: key,
        outcome: "failed",
        lineage: admission.lineage,
        reason: decoded.value.summary,
      });
      yield* coordination.park(admission.event.key, { _tag: "Stuck", summary: decoded.value.summary }, key);
      yield* settle(run, "failed");
      return "completed" as const;
    }

    const actionPlanResult = yield* Effect.result(
      buildWorkflowActionPlan({
        admission,
        document,
        operation,
        catalog: catalogResult.catalog,
        workspaces: registryState.workspaces,
        output: decoded.value,
        attempt: run.id,
        createdAtMillis: yield* Clock.currentTimeMillis,
      }),
    );
    if (Result.isFailure(actionPlanResult)) {
      return yield* refuseResult(admission, key, run, actionPlanResult.failure.message);
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
      yield* settle(run, "interrupted");
      return admission;
    }
    if (execution._tag !== "Complete") {
      const status =
        execution._tag === "AwaitingApproval" || execution._tag === "HandedToYou" ? "succeeded" : "failed";
      yield* settle(run, status);
      return execution._tag === "Retry" ? ("retry" as const) : ("completed" as const);
    }
    yield* coordination.recordAttempt(admission.event.key, {
      operation: key,
      outcome: "succeeded",
      lineage: admission.lineage,
    });
    yield* settle(run, "succeeded");
    if (execution.handOff !== null) {
      return handOffAdmission(admission, execution.handOff, run.id);
    }
    yield* complete(admission);
    return "completed" as const;
  });

  const executeAdmission = (admission: TriggerAdmission) =>
    Effect.reduce(
      Array.from({ length: maxLineageHops + 1 }),
      () => ({ current: initialAdmission(admission), outcome: "completed" as WorkflowRunOutcome }),
      (state) =>
        state.current
          ? executeRaw(state.current).pipe(
              Effect.scoped,
              Effect.map((next) =>
                typeof next === "string"
                  ? { current: null, outcome: next }
                  : { current: next, outcome: state.outcome },
              ),
            )
          : Effect.succeed(state),
    ).pipe(
      Effect.provide(executionContext),
      Effect.map(({ outcome }) => outcome),
    );

  const touchpointFailure = (reason: WorkflowTouchpointFailure["reason"], message: string) =>
    new WorkflowTouchpointFailure({ reason, message });

  const failTouchpoint = (reason: WorkflowTouchpointFailure["reason"], message: string) =>
    Effect.fail(touchpointFailure(reason, message));

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
    inputs: Readonly<Record<string, string>>,
    createdAtMillis: number,
  ) {
    const record = yield* workflows.get({ id: plan.workflow });
    const document = record.publishedCopy;
    const operation = document?.operations.find(({ id }) => id === plan.operation);
    if (document === null || document === undefined || operation === undefined) {
      return yield* failTouchpoint("unavailable", "The published Workflow operation is unavailable");
    }
    const catalogResult = yield* workflows.catalog;
    const registryState = yield* registry.state;
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
    if (execution._tag !== "Complete") return;
    const key = operationKeyOf(admission, plan.operation);
    yield* coordination.recordAttempt(admission.event.key, {
      operation: key,
      outcome: "succeeded",
      lineage: admission.lineage,
    });
    yield* settleAttempt(plan.attempt, "succeeded");
    if (execution.handOff === null) {
      yield* complete(admission);
      return;
    }
    yield* executeAdmission(handOffAdmission(admission, execution.handOff, plan.attempt));
  });

  const approve = Effect.fn("WorkflowRun.approve")(function* (payload: {
    readonly item: WorkItemRef;
    readonly attempt: RunId;
    readonly digest: string;
    readonly edits?: Readonly<Record<string, string>>;
  }) {
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
      approvedDigest: rebuilt.digest,
      steps: rebuilt.steps.map((step) =>
        step.entry === "cogwork.wait-for-approval"
          ? WorkflowActionPlanStep.make({ ...step, status: "completed" })
          : step,
      ),
    });
    yield* actionPlans.save(approved);
    yield* recordDecision(approved, "workflow.plan-approved", { digest: approved.digest });
    const execution = yield* executeWorkflowActionPlan(approved, admission);
    yield* finishTouchpointPlan(approved, admission, execution);
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
    yield* settleAttempt(plan.attempt, "succeeded");
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
    const principal = yield* Principal;
    yield* coordination.handBack(payload.item, { by: principal.id });
    const rebuilt = yield* rebuildPlan(
      plan,
      admission,
      payload.answers,
      { ...plan.inputs, ...payload.inputs },
      yield* Clock.currentTimeMillis,
    );
    yield* actionPlans.save(rebuilt);
    yield* recordDecision(rebuilt, "workflow.answer-chosen", {
      answers: payload.answers,
    });
    const execution = yield* executeWorkflowActionPlan(rebuilt, admission);
    yield* finishTouchpointPlan(rebuilt, admission, execution);
  });

  const handBack = Effect.fn("WorkflowRun.handBack")(function* (payload: {
    readonly item: WorkItemRef;
    readonly note?: string;
  }) {
    const principal = yield* Principal;
    yield* coordination.handBack(payload.item, { by: principal.id, note: payload.note });
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
    touchpoint(effect).pipe(Effect.provide(executionContext));

  return {
    execute: executeAdmission,
    approve: (payload: Parameters<typeof approve>[0]) => runTouchpoint(approve(payload)),
    reject: (payload: Parameters<typeof reject>[0]) => runTouchpoint(reject(payload)),
    chooseAnswer: (payload: Parameters<typeof chooseAnswer>[0]) => runTouchpoint(chooseAnswer(payload)),
    handBack: (payload: Parameters<typeof handBack>[0]) => runTouchpoint(handBack(payload)),
  } as const;
});

export const WorkflowRun = Context.Reference<Effect.Success<typeof make>>(
  "@cogwork/engine/workflow-run/WorkflowRun",
  {
    defaultValue: () => ({
      execute: () => Effect.succeed("completed" as const),
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
