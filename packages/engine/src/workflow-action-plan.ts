import {
  issueTrackerErrorIsPermanent,
  keyOf,
  type MachineReadiness,
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
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Coordination } from "./coordination";
import { actionsOf, IssueTracker, type IssueTrackerActionService, IssueTrackerError } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { WorkspaceRegistry } from "./registry";
import { RunLedger } from "./run-ledger";
import type { TriggerAdmission } from "./trigger-observation";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { WorkflowNotifications } from "./workflow-notification";

export class WorkflowActionPlanDecodeError extends Schema.TaggedError<WorkflowActionPlanDecodeError>()(
  "WorkflowActionPlanDecodeError",
  { message: Schema.String },
) {}

interface OperationOutput {
  readonly summary: string;
  readonly answers: Readonly<Record<string, string>>;
  readonly inputs: Readonly<Record<string, string>>;
}

interface BuildInput {
  readonly admission: TriggerAdmission;
  readonly document: WorkflowDocument;
  readonly operation: WorkflowOperation;
  readonly catalog: WorkflowCatalog;
  readonly machine: MachineReadiness;
  readonly output: OperationOutput;
  readonly attempt: RunId;
  readonly createdAtMillis: number;
}

const actionName = (entry: string) => entry.slice(entry.indexOf(".") + 1);
const systemOf = (entry: WorkflowCatalogEntry) => entry.system;

const selectedWorkspaces = (document: WorkflowDocument, machine: MachineReadiness, system: string) => {
  const selected =
    document.workspaces._tag === "Every"
      ? machine.workspaces.map(({ id }) => id)
      : document.workspaces.workspaces;
  return machine.workspaces
    .filter(({ id, binds }) => selected.includes(id) && binds.includes(system))
    .map(({ id }) => id);
};

const decodeFailure = (message: string) => Effect.fail(WorkflowActionPlanDecodeError.make({ message }));

const workspaceForNewIssue = (
  admission: TriggerAdmission,
  workspaces: ReadonlyArray<WorkspaceId>,
): Effect.Effect<WorkspaceId, WorkflowActionPlanDecodeError> => {
  const eventWorkspace = admission.event.workspace;
  if (eventWorkspace !== null && workspaces.includes(eventWorkspace)) return Effect.succeed(eventWorkspace);
  const workspace = workspaces.at(0);
  return workspace ? Effect.succeed(workspace) : decodeFailure("No selected Workspace binds the action app");
};

const currentIssueTarget = (
  admission: TriggerAdmission,
  workspaces: ReadonlyArray<WorkspaceId>,
): Effect.Effect<WorkflowActionTarget, WorkflowActionPlanDecodeError> => {
  const ref = admission.event.key;
  if (ref._tag !== "Issue" || !workspaces.includes(ref.workspace)) {
    return decodeFailure("The action cannot target this item in the selected Workspaces");
  }
  return Effect.succeed({ _tag: "CurrentIssue", workspace: ref.workspace, issue: ref.id });
};

const existingIssueTarget = Effect.fn("WorkflowActionPlan.existingIssueTarget")(function* (
  issueInput: string,
  workspaces: ReadonlyArray<WorkspaceId>,
) {
  const explicitWorkspace = workspaces.find((workspace) => issueInput.startsWith(`${workspace}:`));
  const workspace = explicitWorkspace ?? (workspaces.length === 1 ? workspaces[0] : undefined);
  if (!workspace) {
    return yield* decodeFailure("The issue input does not identify one selected Workspace");
  }
  const rawIssue = explicitWorkspace ? issueInput.slice(explicitWorkspace.length + 1) : issueInput;
  const issue = yield* Schema.decodeEffect(WorkItemId)(rawIssue).pipe(
    Effect.mapError(() =>
      WorkflowActionPlanDecodeError.make({ message: `The issue input is invalid: ${issueInput}` }),
    ),
  );
  return { _tag: "ExistingIssue", workspace, issue } as const;
});

type TargetProducer = (
  admission: TriggerAdmission,
  workspaces: ReadonlyArray<WorkspaceId>,
  inputs: Readonly<Record<string, string>>,
) => Effect.Effect<WorkflowActionTarget, WorkflowActionPlanDecodeError>;

const targetProducers = new Map<string, TargetProducer>([
  [
    "create-issue",
    (
      admission: TriggerAdmission,
      workspaces: ReadonlyArray<WorkspaceId>,
      _inputs: Readonly<Record<string, string>>,
    ) =>
      workspaceForNewIssue(admission, workspaces).pipe(
        Effect.map((workspace) => ({ _tag: "NewIssue", workspace }) as const),
      ),
  ],
  ["comment-this-item", currentIssueTarget],
  [
    "comment-issue",
    (
      _admission: TriggerAdmission,
      workspaces: ReadonlyArray<WorkspaceId>,
      inputs: Readonly<Record<string, string>>,
    ) => existingIssueTarget(inputs.issue ?? "", workspaces),
  ],
  ["add-label", currentIssueTarget],
  ["remove-label", currentIssueTarget],
  ["close-this-issue", currentIssueTarget],
]);

const cogworkTarget = Effect.succeed<WorkflowActionTarget>({ _tag: "Cogwork" });

const targetFor = (
  entry: WorkflowCatalogEntry,
  admission: TriggerAdmission,
  workspaces: ReadonlyArray<WorkspaceId>,
  inputs: Readonly<Record<string, string>>,
) => {
  const producer = targetProducers.get(actionName(entry.key));
  return entry.system === null || producer === undefined
    ? cogworkTarget
    : producer(admission, workspaces, inputs);
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
  const matched = input.operation.transitions.filter((transition) =>
    transition.when.every(({ question, choice }) => input.output.answers[question] === choice),
  );
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
      const system = systemOf(entry);
      const workspaces = system === null ? [] : selectedWorkspaces(input.document, input.machine, system);
      const target = yield* targetFor(entry, input.admission, workspaces, inputs);
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
  return WorkflowActionPlan.make({
    item: keyOf(input.admission.event.key),
    workflow: input.admission.subscription.workflow,
    attempt: input.attempt,
    operation: input.operation.id,
    revision: input.admission.event.revision,
    createdAtMillis: input.createdAtMillis,
    summary: input.output.summary,
    answers: input.output.answers,
    handOff,
    steps,
  });
});

const parameterValues = (parameters: ReadonlyArray<WorkflowParameterValue>, id: string) =>
  parameters.filter((parameter) => parameter.id === id).map(({ value }) => value);

const targetWorkspace = (step: WorkflowActionPlanStep) =>
  step.target._tag === "Cogwork" ? null : step.target.workspace;

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
  readonly plan: WorkflowActionPlan;
  readonly step: WorkflowActionPlanStep;
  readonly workspace: RegisteredWorkspace | null;
  readonly tracker: IssueTrackerActionService;
  readonly notifications: Effect.Success<typeof WorkflowNotifications>;
  readonly ledger: Effect.Success<typeof RunLedger>;
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
      }),
    });
  }),
  "comment-this-item": Effect.fn("WorkflowActionPlan.commentThisItem")(function* (context: ActionContext) {
    const workspace = yield* requireWorkspace(context);
    const issue = yield* requireIssueTarget(context.step);
    yield* context.tracker.commentIssue(
      workspace,
      issue,
      context.step.inputs.comment ?? "",
      context.step.writeKey,
    );
    return null;
  }),
  "comment-issue": Effect.fn("WorkflowActionPlan.commentIssue")(function* (context: ActionContext) {
    const workspace = yield* requireWorkspace(context);
    const issue = yield* requireIssueTarget(context.step);
    yield* context.tracker.commentIssue(
      workspace,
      issue,
      context.step.inputs.comment ?? "",
      context.step.writeKey,
    );
    return null;
  }),
  "add-label": Effect.fn("WorkflowActionPlan.addLabel")(function* (context: ActionContext) {
    const workspace = yield* requireWorkspace(context);
    const issue = yield* requireIssueTarget(context.step);
    yield* context.tracker.addLabels(
      workspace,
      issue,
      parameterValues(context.step.parameters, "label"),
      context.step.writeKey,
    );
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
        workflow: context.plan.workflow,
        operation: context.plan.operation,
        summary: context.plan.summary,
        answers: context.plan.answers,
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
  "withdraw-pending-approval": () => Effect.succeed(null),
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
  const coordination = yield* Coordination;
  const tracker = actionsOf(yield* IssueTracker);
  const notifications = yield* WorkflowNotifications;
  const ledger = yield* RunLedger;
  const registry = yield* WorkspaceRegistry;
  const waiting = initial.steps.find(
    ({ entry, status }) => entry === "cogwork.wait-for-approval" && status === "pending",
  );
  const coordinationView = yield* coordination.read(admission.event.key);
  const approvalReleased =
    waiting !== undefined && coordinationView.barrierAtMillis > initial.createdAtMillis;
  if (waiting && !approvalReleased) {
    yield* coordination.park(admission.event.key, {
      _tag: "AwaitingApproval",
      plan: initial.attempt,
      digest: initial.attempt,
      revision: initial.revision,
    });
    yield* coordination.markProcessed(admission.event.key, admission.event.revision);
    return { _tag: "Parked" } as const;
  }
  const resumed = waiting ? replaceStep(initial, waiting, { status: "completed" }) : initial;
  if (approvalReleased) yield* store.save(resumed);
  const registryState = yield* registry.state;
  const pending = resumed.steps.filter(({ status }) => status === "pending");
  const state = yield* Effect.reduce(
    pending,
    () => initialExecutionState(resumed),
    (state, step) =>
      Effect.gen(function* () {
        if (state.result !== null) return state;
        const executor = executorFor(step);
        if (!executor) {
          const plan = replaceStep(state.plan, step, { status: "completed" });
          yield* store.save(plan);
          return initialExecutionState(plan);
        }
        const workspaceId = targetWorkspace(step);
        const workspace =
          workspaceId === null
            ? null
            : (registryState.workspaces.find(({ config }) => config.name === workspaceId) ?? null);
        const context = { plan: state.plan, step, workspace, tracker, notifications, ledger };
        const result = yield* Effect.result(executor(context));
        if (result._tag === "Success") {
          const plan = replaceStep(state.plan, step, {
            status: "completed",
            artifact: result.success,
          });
          yield* store.save(plan);
          return initialExecutionState(plan);
        }
        const error = result.failure;
        const failures = step.failures + 1;
        const parked = issueTrackerErrorIsPermanent(error) || failures >= 3;
        const plan = replaceStep(state.plan, step, {
          failures,
          status: parked ? "failed" : "pending",
        });
        yield* store.save(plan);
        if (!parked) {
          return { plan, result: { _tag: "Retry" } } satisfies ExecutionState;
        }
        yield* coordination.park(admission.event.key, {
          _tag: "WriteFailed",
          step: step.entry,
          error: error.message,
        });
        yield* coordination.markProcessed(admission.event.key, admission.event.revision);
        return { plan, result: { _tag: "Parked" } } satisfies ExecutionState;
      }),
  );
  if (state.result !== null) return state.result;
  const handedToPerson = state.plan.steps.some(
    ({ entry, status }) => entry === "cogwork.hand-to-me" && status === "completed",
  );
  if (handedToPerson) {
    yield* coordination.park(admission.event.key, { _tag: "HandedToYou" });
    yield* coordination.markProcessed(admission.event.key, admission.event.revision);
    return { _tag: "Parked" } as const;
  }
  yield* store.remove(state.plan.item, state.plan.workflow, state.plan.attempt);
  return { _tag: "Complete", handOff: state.plan.handOff } as const;
});
