import { createHash } from "node:crypto";
import {
  issueTrackerErrorIsPermanent,
  keyOf,
  matchWorkflowTransitions,
  type RunId,
  type WorkflowActionArtifact,
  WorkflowActionOrigin,
  WorkflowActionPlan,
  WorkflowActionPlanStep,
  type WorkflowActionTarget,
  type WorkflowCatalog,
  type WorkflowCatalogEntry,
  type WorkflowDocument,
  type WorkflowNodeId,
  type WorkflowOperation,
  type WorkflowParameterValue,
  WorkItemId,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Coordination } from "./coordination";
import { IssueTracker, type IssueTrackerActionService, IssueTrackerError } from "./issue-tracker";
import type { RegisteredWorkspace, WorkspaceIssueTrackerBinding } from "./projector";
import { RunLedger } from "./run-ledger";
import { type TriggerAdmission, TriggerObservationStore } from "./trigger-observation";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { WorkflowArtifactStore } from "./workflow-artifact-store";
import { WorkflowNotifications } from "./workflow-notification";

export class WorkflowActionPlanDecodeError extends Schema.TaggedError<WorkflowActionPlanDecodeError>()(
  "WorkflowActionPlanDecodeError",
  { message: Schema.String },
) {}

const planPreview = (plan: WorkflowActionPlan) =>
  JSON.stringify({
    summary: plan.summary,
    steps: plan.steps.map(({ position, entry }) => ({ position, entry })),
  });

interface OperationOutput {
  readonly summary: string;
  readonly answers: Readonly<Record<string, string>>;
  readonly inputs: Readonly<Record<string, string>>;
  readonly workspace?: string;
}

interface BuildInput {
  readonly admission: TriggerAdmission;
  readonly document: WorkflowDocument;
  readonly operation: WorkflowOperation;
  readonly catalog: WorkflowCatalog;
  readonly workspaces: ReadonlyArray<RegisteredWorkspace>;
  readonly output: OperationOutput;
  readonly attempt: RunId;
  readonly createdAtMillis: number;
  readonly workflowRevision: number;
}

const actionName = (entry: string) => entry.slice(entry.indexOf(".") + 1);
const selectedWorkspaces = (document: WorkflowDocument, workspaces: ReadonlyArray<RegisteredWorkspace>) => {
  const selected =
    document.workspaces._tag === "Every"
      ? workspaces.map(({ config }) => config.name)
      : document.workspaces.workspaces;
  return workspaces.filter(({ config }) => selected.includes(config.name));
};

const decodeFailure = (message: string) => Effect.fail(WorkflowActionPlanDecodeError.make({ message }));

const planJson = Schema.fromJsonString(WorkflowActionPlan);

const digestWorkflowActionPlan = Effect.fn("WorkflowActionPlan.digest")(function* (plan: WorkflowActionPlan) {
  const encoded = yield* Schema.encodeEffect(planJson)(
    WorkflowActionPlan.make({ ...plan, digest: "pending" }),
  ).pipe(
    Effect.mapError(() => WorkflowActionPlanDecodeError.make({ message: "Action plan encoding failed" })),
  );
  return createHash("sha256").update(encoded).digest("hex");
});

type FrozenIssueTarget = Omit<WorkspaceIssueTrackerBinding, "config"> & {
  readonly app: WorkspaceIssueTrackerBinding["config"]["issueTracker"]["type"];
  readonly config: WorkspaceIssueTrackerBinding["config"];
};

const issueTrackerApps = ["github", "linear"] as const;

const frozenIssueTarget = Effect.fn("WorkflowActionPlan.frozenIssueTarget")(function* (
  entry: WorkflowCatalogEntry,
  selected: ReadonlyArray<RegisteredWorkspace>,
  workspaceId: string | undefined,
) {
  if (workspaceId === "none") return null;
  if (workspaceId === undefined) return yield* decodeFailure(`Action ${entry.key} needs a Workspace`);
  const app = issueTrackerApps.find((candidate) => candidate === entry.system);
  const workspace = selected.find(({ config }) => config.name === workspaceId);
  if (!app || workspace?.config.issueTracker.type !== app) {
    return yield* decodeFailure(`Workspace ${workspaceId} does not bind ${entry.system ?? "the action app"}`);
  }
  return {
    app: workspace.config.issueTracker.type,
    config: { name: workspace.config.name, issueTracker: workspace.config.issueTracker },
    repository: workspace.repository,
  } satisfies FrozenIssueTarget;
});

const targetFields = (target: FrozenIssueTarget) => ({
  workspace: target.config.name,
  app: target.app,
  issueTracker: target.config.issueTracker,
  repository: target.repository ?? null,
});

const currentIssueTarget = (admission: TriggerAdmission, target: FrozenIssueTarget | null) => {
  if (target === null) return Effect.succeed<WorkflowActionTarget>({ _tag: "NoWorkspace" });
  const ref = admission.event.key;
  if (ref._tag !== "Issue" || ref.workspace !== target.config.name) {
    return decodeFailure("The action cannot target this item in the selected Workspaces");
  }
  return Effect.succeed<WorkflowActionTarget>({
    _tag: "CurrentIssue",
    ...targetFields(target),
    issue: ref.id,
  });
};

const existingIssueTarget = Effect.fn("WorkflowActionPlan.existingIssueTarget")(function* (
  issueInput: string,
  target: FrozenIssueTarget | null,
) {
  if (target === null) return { _tag: "NoWorkspace" } as const;
  const prefix = `${target.config.name}:`;
  const hasWorkspacePrefix = issueInput.includes(":");
  if (hasWorkspacePrefix && !issueInput.startsWith(prefix)) {
    return yield* decodeFailure("The issue input does not identify the selected Workspace");
  }
  const rawIssue = issueInput.startsWith(prefix) ? issueInput.slice(prefix.length) : issueInput;
  const issue = yield* Schema.decodeEffect(WorkItemId)(rawIssue).pipe(
    Effect.mapError(() =>
      WorkflowActionPlanDecodeError.make({ message: `The issue input is invalid: ${issueInput}` }),
    ),
  );
  return { _tag: "ExistingIssue", ...targetFields(target), issue } as const;
});

type TargetProducer = (
  admission: TriggerAdmission,
  target: FrozenIssueTarget | null,
  inputs: Readonly<Record<string, string>>,
) => Effect.Effect<WorkflowActionTarget, WorkflowActionPlanDecodeError>;

const targetProducers = new Map<string, TargetProducer>([
  [
    "create-issue",
    (
      _admission: TriggerAdmission,
      target: FrozenIssueTarget | null,
      _inputs: Readonly<Record<string, string>>,
    ) =>
      Effect.succeed<WorkflowActionTarget>(
        target === null ? { _tag: "NoWorkspace" } : { _tag: "NewIssue", ...targetFields(target) },
      ),
  ],
  ["comment-this-item", currentIssueTarget],
  [
    "comment-issue",
    (
      _admission: TriggerAdmission,
      target: FrozenIssueTarget | null,
      inputs: Readonly<Record<string, string>>,
    ) => existingIssueTarget(inputs.issue ?? "", target),
  ],
  ["add-label", currentIssueTarget],
  ["remove-label", currentIssueTarget],
  ["close-this-issue", currentIssueTarget],
]);

const cogworkTarget = Effect.succeed<WorkflowActionTarget>({ _tag: "Cogwork" });

const targetFor = (
  entry: WorkflowCatalogEntry,
  admission: TriggerAdmission,
  workspaces: ReadonlyArray<RegisteredWorkspace>,
  inputs: Readonly<Record<string, string>>,
  workspace: string | undefined,
) => {
  const producer = targetProducers.get(actionName(entry.key));
  if (entry.system === null || producer === undefined) return cogworkTarget;
  return frozenIssueTarget(entry, workspaces, workspace).pipe(
    Effect.flatMap((target) => producer(admission, target, inputs)),
  );
};

const inputsFor = Effect.fn("WorkflowActionPlan.inputsFor")(function* (
  entry: WorkflowCatalogEntry,
  output: OperationOutput,
) {
  return yield* Effect.forEach(entry.agentInputs, (name) => {
    const value = output.inputs[name]?.trim() ?? "";
    return value.length === 0
      ? decodeFailure(`Action ${entry.key} needs non-empty input ${name}`)
      : Effect.succeed([name, value] as const);
  }).pipe(Effect.map(Object.fromEntries));
});

const actionRanks = [
  { when: (entry: string) => entry === "cogwork.wait-for-approval", rank: 0 },
  { when: (entry: string) => entry === "cogwork.notify", rank: 2 },
  {
    when: (entry: string) => entry === "cogwork.hand-to-me" || entry === "cogwork.stop",
    rank: 3,
  },
] as const;

const actionRank = (entry: string) => actionRanks.find(({ when }) => when(entry))?.rank ?? 1;

export const buildWorkflowActionPlan = Effect.fn("WorkflowActionPlan.build")(function* (input: BuildInput) {
  const entries = new Map(input.catalog.entries.map((entry) => [entry.key, entry]));
  const matched = matchWorkflowTransitions(input.operation, input.output.answers);
  const actions = matched
    .flatMap(({ actions }) => actions)
    .map((action, documentPosition) => ({ action, documentPosition }))
    .toSorted(
      (left, right) =>
        actionRank(left.action.entry) - actionRank(right.action.entry) ||
        left.documentPosition - right.documentPosition,
    );
  const steps = yield* Effect.forEach(actions, ({ action }, position) =>
    Effect.gen(function* () {
      const entry = entries.get(action.entry);
      if (entry?.kind !== "action") {
        return yield* decodeFailure(`Unknown action ${action.entry}`);
      }
      const inputs = yield* inputsFor(entry, input.output);
      const workspaces = selectedWorkspaces(input.document, input.workspaces);
      const target = yield* targetFor(entry, input.admission, workspaces, inputs, input.output.workspace);
      return WorkflowActionPlanStep.make({
        position,
        entry: entry.key,
        parameters: action.parameters,
        inputs,
        target,
        writeKey: `${keyOf(input.admission.event.key)}:${input.operation.id}:${input.attempt}:${position}`,
        status: "pending",
        failures: 0,
        artifact: null,
      });
    }),
  );
  const handOff = matched.flatMap(({ handOff }) => (handOff === null ? [] : [handOff])).at(0) ?? null;
  const content = {
    item: keyOf(input.admission.event.key),
    workflow: input.admission.subscription.workflow,
    attempt: input.attempt,
    operation: input.operation.id,
    revision: input.admission.event.revision,
    createdAtMillis: input.createdAtMillis,
    consumedHandbackAtMillis: 0,
    workflowRevision: input.workflowRevision,
    summary: input.output.summary,
    answers: input.output.answers,
    inputs: input.output.inputs,
    workspace: input.output.workspace ?? null,
    lineage: input.admission.lineage,
    handOff,
    steps,
  } as const;
  const pending = WorkflowActionPlan.make({ ...content, digest: "pending" });
  const digest = yield* digestWorkflowActionPlan(pending);
  return WorkflowActionPlan.make({ ...pending, digest });
});

const parameterValues = (parameters: ReadonlyArray<WorkflowParameterValue>, id: string) =>
  parameters.filter((parameter) => parameter.id === id).map(({ value }) => value);

const targetWorkspace = (step: WorkflowActionPlanStep) => {
  const target = step.target;
  if (target._tag === "Cogwork" || target._tag === "NoWorkspace") return null;
  const app = actionName(step.entry) === step.entry ? null : step.entry.slice(0, step.entry.indexOf("."));
  const matchesApp = app === target.app && target.issueTracker.type === target.app;
  if (!matchesApp) return null;
  return {
    config: { name: target.workspace, issueTracker: target.issueTracker },
    ...(target.repository === null ? {} : { repository: target.repository }),
  };
};

const targetIssue = (step: WorkflowActionPlanStep) => {
  const target = step.target;
  return target._tag === "CurrentIssue" || target._tag === "ExistingIssue" ? target.issue : null;
};

const invalidTarget = (step: WorkflowActionPlanStep) =>
  new IssueTrackerError({
    reason: "unavailable",
    retryable: false,
    message: `Action ${step.entry} has an invalid target`,
  });

interface ActionContext {
  readonly item: TriggerAdmission["event"]["key"];
  readonly plan: WorkflowActionPlan;
  readonly step: WorkflowActionPlanStep;
  readonly workspace: WorkspaceIssueTrackerBinding | null;
  readonly tracker: IssueTrackerActionService;
  readonly notifications: Effect.Success<typeof WorkflowNotifications>;
  readonly ledger: Effect.Success<typeof RunLedger>;
  readonly actionPlans: Effect.Success<typeof WorkflowActionPlanStore>;
  readonly coordination: Effect.Success<typeof Coordination>;
  readonly observationStore: Effect.Success<typeof TriggerObservationStore>;
}

const requireIssueTarget = (step: WorkflowActionPlanStep) => {
  const issue = targetIssue(step);
  return issue === null ? Effect.fail(invalidTarget(step)) : Effect.succeed(issue);
};

const requireWorkspace = (context: ActionContext) =>
  context.workspace === null ? Effect.fail(invalidTarget(context.step)) : Effect.succeed(context.workspace);

type ActionExecutor = (
  context: ActionContext,
) => Effect.Effect<WorkflowActionArtifact | null, IssueTrackerError>;

const commentIssue = Effect.fn("WorkflowActionPlan.commentIssue")(function* (context: ActionContext) {
  const workspace = yield* requireWorkspace(context);
  const issue = yield* requireIssueTarget(context.step);
  yield* context.tracker.commentIssue(
    workspace,
    issue,
    context.step.inputs.comment ?? "",
    context.step.writeKey,
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
  const endedAtMillis = yield* Clock.currentTimeMillis;
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
        const run = yield* context.ledger.getRun(plan.attempt);
        if (run !== null) {
          yield* context.ledger.updateRun(plan.attempt, {
            status: "interrupted",
            usage: null,
            endedAtMillis,
          });
        }
      }),
    { discard: true },
  );
  return null;
});

const withdrawPendingApproval = (context: ActionContext) =>
  withdrawPendingApprovalRaw(context).pipe(Effect.mapError(actionFailure));

const actionExecutors = {
  "create-issue": Effect.fn("WorkflowActionPlan.createIssue")(function* (context: ActionContext) {
    const workspace = yield* requireWorkspace(context);
    if (context.step.target._tag !== "NewIssue") return yield* invalidTarget(context.step);
    return yield* context.tracker.createIssue(workspace, {
      title: context.step.inputs.issue_title ?? "",
      body: context.step.inputs.issue_body ?? "",
      labels: parameterValues(context.step.parameters, "label"),
      origin: WorkflowActionOrigin.make({
        item: context.plan.item,
        workflow: context.plan.workflow,
        attempt: context.plan.attempt,
        writeKey: context.step.writeKey,
        lineage: context.plan.lineage,
      }),
    });
  }),
  "comment-this-item": commentIssue,
  "comment-issue": commentIssue,
  "add-label": Effect.fn("WorkflowActionPlan.addLabel")(function* (context: ActionContext) {
    const workspace = yield* requireWorkspace(context);
    const issue = yield* requireIssueTarget(context.step);
    const labels = parameterValues(context.step.parameters, "label");
    if (labels.length === 0) return yield* invalidTarget(context.step);
    yield* context.tracker.addLabels(workspace, issue, labels, context.step.writeKey);
    return null;
  }),
  "remove-label": Effect.fn("WorkflowActionPlan.removeLabel")(function* (context: ActionContext) {
    const workspace = yield* requireWorkspace(context);
    const issue = yield* requireIssueTarget(context.step);
    const label = parameterValues(context.step.parameters, "label").at(0);
    if (!label) return yield* invalidTarget(context.step);
    yield* context.tracker.removeLabel(workspace, issue, label, context.step.writeKey);
    return null;
  }),
  "close-this-issue": Effect.fn("WorkflowActionPlan.closeIssue")(function* (context: ActionContext) {
    const workspace = yield* requireWorkspace(context);
    const issue = yield* requireIssueTarget(context.step);
    yield* context.tracker.closeIssue(workspace, issue, context.step.writeKey);
    return null;
  }),
  notify: Effect.fn("WorkflowActionPlan.notify")(function* (context: ActionContext) {
    const run = yield* context.ledger.getRun(context.plan.attempt);
    if (run === null) return yield* invalidTarget(context.step);
    yield* context.notifications
      .write(run, {
        id: `${context.plan.workflow}:${context.plan.operation}:${context.plan.revision}`,
        item: context.item,
        workflow: context.plan.workflow,
        operation: context.plan.operation,
        summary: context.step.inputs.notification ?? "",
        answers: context.plan.answers,
        artifacts: context.plan.steps.flatMap(({ artifact }) => (artifact === null ? [] : [artifact])),
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
  }),
  stop: () => Effect.succeed(null),
  "hand-to-me": () => Effect.succeed(null),
  "withdraw-pending-approval": withdrawPendingApproval,
} satisfies Record<string, ActionExecutor>;

const executorFor = (step: WorkflowActionPlanStep) => {
  const name = actionName(step.entry);
  return Object.entries(actionExecutors).find(([candidate]) => candidate === name)?.[1];
};

const replaceStep = (
  plan: WorkflowActionPlan,
  step: WorkflowActionPlanStep,
  update: Partial<WorkflowActionPlanStep>,
) =>
  WorkflowActionPlan.make({
    ...plan,
    steps: plan.steps.map((candidate) =>
      candidate.position === step.position
        ? WorkflowActionPlanStep.make({ ...candidate, ...update })
        : candidate,
    ),
  });

export type WorkflowActionPlanExecution =
  | { readonly _tag: "Complete"; readonly handOff: WorkflowNodeId | null }
  | { readonly _tag: "Retry" }
  | { readonly _tag: "Replan" }
  | { readonly _tag: "AwaitingApproval" }
  | { readonly _tag: "HandedToYou" }
  | { readonly _tag: "Parked" };

interface ExecutionState {
  readonly plan: WorkflowActionPlan;
  readonly result: WorkflowActionPlanExecution | null;
}

const initialExecutionState = (plan: WorkflowActionPlan): ExecutionState => ({ plan, result: null });

export const executeWorkflowActionPlan = Effect.fn("WorkflowActionPlan.execute")(function* (
  initial: WorkflowActionPlan,
  admission: TriggerAdmission,
) {
  const store = yield* WorkflowActionPlanStore;
  const artifacts = yield* WorkflowArtifactStore;
  const coordination = yield* Coordination;
  const tracker = yield* IssueTracker;
  const notifications = yield* WorkflowNotifications;
  const ledger = yield* RunLedger;
  const observationStore = yield* TriggerObservationStore;
  const coordinationView = yield* coordination.read(admission.event.key);
  const handbackAfterPlan = coordinationView.barrierAtMillis > initial.createdAtMillis;
  const hasFreshHandback =
    coordinationView.barrierAtMillis > Math.max(initial.createdAtMillis, initial.consumedHandbackAtMillis);
  const hasFailedWrite = initial.steps.some(({ status }) => status === "failed");
  if (hasFailedWrite && !hasFreshHandback) return { _tag: "Parked" } as const;
  const handedToPerson = initial.steps.some(
    ({ entry, status }) => entry === "cogwork.hand-to-me" && status === "completed",
  );
  if (handedToPerson && hasFreshHandback) {
    yield* store.remove(initial.item, initial.workflow, initial.attempt);
    return { _tag: "Replan" } as const;
  }
  const lacksWorkspace = initial.steps.some(
    ({ target, status }) => target._tag === "NoWorkspace" && status === "pending",
  );
  if (lacksWorkspace) {
    if (handbackAfterPlan) {
      yield* store.remove(initial.item, initial.workflow, initial.attempt);
      return { _tag: "Replan" } as const;
    }
    yield* coordination.park(admission.event.key, {
      _tag: "NoWorkspaceRecognized",
      plan: planPreview(initial),
    });
    return { _tag: "Parked" } as const;
  }
  const waiting = initial.steps.find(
    ({ entry, status }) => entry === "cogwork.wait-for-approval" && status === "pending",
  );
  if (waiting && handbackAfterPlan) {
    yield* store.remove(initial.item, initial.workflow, initial.attempt);
    return { _tag: "Replan" } as const;
  }
  if (waiting) {
    yield* coordination.park(admission.event.key, {
      _tag: "AwaitingApproval",
      plan: initial.attempt,
      digest: initial.digest,
      revision: initial.revision,
    });
    return { _tag: "AwaitingApproval" } as const;
  }
  const planForParking = (plan: WorkflowActionPlan) =>
    hasFailedWrite
      ? WorkflowActionPlan.make({
          ...plan,
          consumedHandbackAtMillis: coordinationView.barrierAtMillis,
        })
      : plan;
  const pending = initial.steps.filter(({ status }) => status === "pending");
  const state = yield* Effect.reduce(
    pending,
    () => initialExecutionState(initial),
    (state, step) =>
      Effect.gen(function* () {
        if (state.result !== null) return state;
        const executor = executorFor(step);
        if (!executor) {
          const error = invalidTarget(step);
          const plan = planForParking(
            replaceStep(state.plan, step, { failures: step.failures + 1, status: "failed" }),
          );
          yield* store.save(plan);
          yield* coordination.park(admission.event.key, {
            _tag: "WriteFailed",
            step: step.entry,
            error: error.message,
          });
          return { plan, result: { _tag: "Parked" } } satisfies ExecutionState;
        }
        const workspace = targetWorkspace(step);
        const context = {
          item: admission.event.key,
          plan: state.plan,
          step,
          workspace,
          tracker,
          notifications,
          ledger,
          actionPlans: store,
          coordination,
          observationStore,
        };
        const result = yield* Effect.result(executor(context));
        if (result._tag === "Success") {
          const plan = replaceStep(state.plan, step, {
            status: "completed",
            artifact: result.success,
          });
          if (result.success !== null) yield* artifacts.record(result.success);
          yield* store.save(plan);
          return initialExecutionState(plan);
        }
        const error = result.failure;
        const failures = step.failures + 1;
        const parked = issueTrackerErrorIsPermanent(error) || failures >= 3;
        const updated = replaceStep(state.plan, step, {
          failures,
          status: parked ? "failed" : "pending",
        });
        const plan = parked ? planForParking(updated) : updated;
        yield* store.save(plan);
        if (!parked) {
          return { plan, result: { _tag: "Retry" } } satisfies ExecutionState;
        }
        yield* coordination.park(admission.event.key, {
          _tag: "WriteFailed",
          step: step.entry,
          error: error.message,
        });
        return { plan, result: { _tag: "Parked" } } satisfies ExecutionState;
      }),
  );
  if (state.result !== null) return state.result;
  const hasHandToMe = state.plan.steps.some(
    ({ entry, status }) => entry === "cogwork.hand-to-me" && status === "completed",
  );
  const stopped = state.plan.steps.some(
    ({ entry, status }) => entry === "cogwork.stop" && status === "completed",
  );
  if (hasHandToMe) {
    yield* coordination.park(admission.event.key, { _tag: "HandedToYou" });
    return { _tag: "HandedToYou" } as const;
  }
  yield* store.remove(state.plan.item, state.plan.workflow, state.plan.attempt);
  const clearsHandOff = stopped;
  return { _tag: "Complete", handOff: clearsHandOff ? null : state.plan.handOff } as const;
});
