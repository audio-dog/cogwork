// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash } from "node:crypto";
import {
  issueTrackerErrorIsPermanent,
  keyOf,
  matchWorkflowTransitions,
  type RunId,
  SlackWriteKey,
  WorkflowActionArtifact,
  WorkflowActionOrigin,
  WorkflowActionPlan,
  type WorkflowActionPlanArtifact,
  WorkflowActionPlanStep,
  WorkflowActionTarget,
  type WorkflowAgentInputValue,
  type WorkflowCatalog,
  type WorkflowCatalogEntry,
  type WorkflowDocument,
  type WorkflowNodeId,
  type WorkflowOperation,
  type WorkflowParameterValue,
  WorkflowSlackActionArtifact,
  WorkItemRef,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Coordination } from "./coordination";
import { IssueTracker } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { WorkspaceRegistry } from "./registry";
import { RunLedger } from "./run-ledger";
import { type SlackPostReceipt, SlackWrite, SlackWriteError } from "./slack-write";
import { SourceControlProvider, type SourceControlProviderService } from "./source-control";
import { type TriggerAdmission, TriggerObservationStore } from "./trigger-observation";
import {
  type ActionContext,
  type ActionExecutor,
  decodeFailure,
  invalidTarget,
  type PullRequestSnapshot,
  parameterValues,
  stringInput,
  type TargetProducer,
  WorkflowActionPlanDecodeError,
} from "./workflow-action-entry";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { actionEntryFor, compareActionPhase } from "./workflow-action-registry";
import { WorkflowArtifactStore } from "./workflow-artifact-store";
import { WorkflowNotifications } from "./workflow-notification";
import { WorktreeManager, type WorktreeManagerService } from "./worktree";

const planPreview = (plan: WorkflowActionPlan) =>
  JSON.stringify({
    summary: plan.summary,
    steps: plan.steps.map(({ position, entry }) => ({ position, entry })),
  });

interface OperationOutput {
  readonly summary: string;
  readonly answers: Readonly<Record<string, string>>;
  readonly inputs: Readonly<Record<string, WorkflowAgentInputValue>>;
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
  readonly sourceControl?: SourceControlProviderService;
  readonly worktrees?: WorktreeManagerService;
  readonly runBranch?: string;
  readonly pullRequestSnapshots?: ReadonlyArray<PullRequestSnapshot>;
}

const actionName = (entry: string) => entry.slice(entry.indexOf(".") + 1);
const selectedWorkspaces = (document: WorkflowDocument, workspaces: ReadonlyArray<RegisteredWorkspace>) => {
  const selected =
    document.workspaces._tag === "Every"
      ? workspaces.map(({ config }) => config.name)
      : document.workspaces.workspaces;
  return workspaces.filter(({ config }) => selected.includes(config.name));
};

const planJson = Schema.fromJsonString(WorkflowActionPlan);

const digestWorkflowActionPlan = Effect.fn("WorkflowActionPlan.digest")(function* (plan: WorkflowActionPlan) {
  const encoded = yield* Schema.encodeEffect(planJson)(
    WorkflowActionPlan.make({ ...plan, digest: "pending" }),
  ).pipe(
    Effect.mapError(() =>
      WorkflowActionPlanDecodeError.make({ reason: "invalid", message: "Action plan encoding failed" }),
    ),
  );
  return createHash("sha256").update(encoded).digest("hex");
});

const cogworkTarget = Effect.succeed<WorkflowActionTarget>({ _tag: "Cogwork" });

const decodeSlackTarget = Schema.decodeUnknownEffect(WorkflowActionTarget);

const slackTarget = (target: unknown) =>
  decodeSlackTarget(target).pipe(
    Effect.mapError(() =>
      WorkflowActionPlanDecodeError.make({ reason: "invalid", message: "The Slack target is invalid" }),
    ),
  );

const slackItemTarget: TargetProducer = ({ admission }) =>
  WorkItemRef.matchOrElse(
    admission.event.key,
    {
      SlackMessage: ({ team, channel, ts, threadTs }) =>
        slackTarget({
          _tag: "SlackMessage",
          team,
          channel,
          ts,
          threadTs: threadTs ?? ts,
        }),
      SlackConversation: ({ team, channel, threadTs }) =>
        slackTarget({
          _tag: "SlackMessage",
          team,
          channel,
          ts: threadTs,
          threadTs,
        }),
    },
    () => decodeFailure("The Slack action needs a Slack item"),
  );

const slackChannelTarget: TargetProducer = ({ parameters }) => {
  const channel = parameters.find(({ id }) => id === "channel")?.value.trim();
  return channel
    ? slackTarget({ _tag: "SlackChannel", channel })
    : decodeFailure("The Slack message action needs a channel");
};

const targetProducers = new Map<string, TargetProducer>([
  ["send-message", slackChannelTarget],
  ["reply-in-thread", slackItemTarget],
  ["add-reaction", slackItemTarget],
  ["draft-reply-in-slack", slackItemTarget],
]);

const targetFor = (
  entry: WorkflowCatalogEntry,
  input: BuildInput,
  workspaces: ReadonlyArray<RegisteredWorkspace>,
  inputs: Readonly<Record<string, WorkflowAgentInputValue>>,
  parameters: ReadonlyArray<WorkflowParameterValue>,
) => {
  const context = {
    entry,
    admission: input.admission,
    workspaces,
    inputs,
    parameters,
    workspace: input.output.workspace,
    sourceControl: input.sourceControl,
    worktrees: input.worktrees,
    runBranch: input.runBranch,
    pullRequestSnapshots: input.pullRequestSnapshots,
  };
  const registered = actionEntryFor(entry.key);
  if (registered) return registered.target(context);
  return targetProducers.get(actionName(entry.key))?.(context) ?? cogworkTarget;
};

const inputsFor = Effect.fn("WorkflowActionPlan.inputsFor")(function* (
  entry: WorkflowCatalogEntry,
  output: OperationOutput,
) {
  const inputFor = (
    name: string,
  ): Effect.Effect<readonly [string, WorkflowAgentInputValue], WorkflowActionPlanDecodeError> => {
    const value = output.inputs[name];
    if (value !== undefined && typeof value !== "string") return Effect.succeed([name, value]);
    const trimmed = value?.trim() ?? "";
    return trimmed.length === 0
      ? decodeFailure(`Action ${entry.key} needs non-empty input ${name}`)
      : Effect.succeed([name, trimmed]);
  };
  const entries = yield* Effect.forEach(entry.agentInputs, inputFor);
  return Object.fromEntries(entries);
});

export const buildWorkflowActionPlan = Effect.fn("WorkflowActionPlan.build")(function* (input: BuildInput) {
  const entries = new Map(input.catalog.entries.map((entry) => [entry.key, entry]));
  const matched = matchWorkflowTransitions(input.operation, input.output.answers);
  const actions = matched
    .flatMap(({ actions }) => actions)
    .map((action, documentPosition) => ({ action, documentPosition }))
    .toSorted(
      (left, right) =>
        compareActionPhase(left.action.entry, right.action.entry) ||
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
      const target = yield* targetFor(entry, input, workspaces, inputs, action.parameters);
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

const targetWorkspace = (step: WorkflowActionPlanStep) => {
  const target = step.target;
  if (!WorkflowActionTarget.isAnyOf(["CurrentIssue", "ExistingIssue", "NewIssue"])(target)) return null;
  const app = actionName(step.entry) === step.entry ? null : step.entry.slice(0, step.entry.indexOf("."));
  const matchesApp = app === target.app && target.issueTracker.type === target.app;
  if (!matchesApp) return null;
  return {
    config: { name: target.workspace, issueTracker: target.issueTracker },
    ...(target.repository === null ? {} : { repository: target.repository }),
  };
};

const sourceTargetWorkspace = (
  step: WorkflowActionPlanStep,
  workspaces: ReadonlyArray<RegisteredWorkspace>,
) => {
  const target = step.target;
  if (!WorkflowActionTarget.isAnyOf(["NewPullRequest", "CurrentPullRequest", "NamedPullRequest"])(target)) {
    return null;
  }
  const workspace = workspaces.find(({ config }) => config.name === target.workspace);
  const app = workspace?.config.sourceControl?.type ?? workspace?.config.issueTracker.type;
  return app === target.app ? (workspace ?? null) : null;
};

const slackInvalidTarget = (step: WorkflowActionPlanStep) =>
  new SlackWriteError({
    reason: "invalid",
    retryable: false,
    message: `Action ${step.entry} has an invalid target`,
  });

const requireSlackMessage = (step: WorkflowActionPlanStep) =>
  WorkflowActionTarget.guards.SlackMessage(step.target)
    ? Effect.succeed(step.target)
    : Effect.fail(slackInvalidTarget(step));

const requireSlackWriteKey = (step: WorkflowActionPlanStep) =>
  Schema.decodeEffect(SlackWriteKey)(step.writeKey).pipe(Effect.mapError(() => slackInvalidTarget(step)));

const slackArtifact = (context: ActionContext, receipt: SlackPostReceipt) =>
  WorkflowSlackActionArtifact.make({
    ...receipt,
    origin: WorkflowActionOrigin.make({
      item: context.plan.item,
      workflow: context.plan.workflow,
      attempt: context.plan.attempt,
      writeKey: context.step.writeKey,
      lineage: context.plan.lineage,
    }),
  });

const actionExecutors: Record<string, ActionExecutor> = {
  "send-message": Effect.fn("WorkflowActionPlan.sendSlackMessage")(function* (context: ActionContext) {
    if (!WorkflowActionTarget.guards.SlackChannel(context.step.target)) {
      return yield* slackInvalidTarget(context.step);
    }
    const writeKey = yield* requireSlackWriteKey(context.step);
    const receipt = yield* context.slack.sendMessage(
      context.step.target.channel,
      stringInput(context.step, "message"),
      writeKey,
    );
    return slackArtifact(context, receipt);
  }),
  "reply-in-thread": Effect.fn("WorkflowActionPlan.replyInSlackThread")(function* (context: ActionContext) {
    const target = yield* requireSlackMessage(context.step);
    const writeKey = yield* requireSlackWriteKey(context.step);
    const receipt = yield* context.slack.replyInThread(target, stringInput(context.step, "reply"), writeKey);
    return slackArtifact(context, receipt);
  }),
  "add-reaction": Effect.fn("WorkflowActionPlan.addSlackReaction")(function* (context: ActionContext) {
    const target = yield* requireSlackMessage(context.step);
    const emoji = parameterValues(context.step.parameters, "emoji").at(0);
    if (!emoji) return yield* slackInvalidTarget(context.step);
    yield* context.slack.addReaction(target, emoji);
    return null;
  }),
  "draft-reply-in-slack": Effect.fn("WorkflowActionPlan.draftSlackReply")(function* (context: ActionContext) {
    const target = yield* requireSlackMessage(context.step);
    yield* context.slack.draftReply(target, stringInput(context.step, "reply"));
    return null;
  }),
};

const executorFor = (step: WorkflowActionPlanStep) => {
  const registered = actionEntryFor(step.entry);
  if (registered) return registered.execute;
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
  const sourceControl = Option.getOrNull(yield* Effect.serviceOption(SourceControlProvider));
  const worktrees = Option.getOrNull(yield* Effect.serviceOption(WorktreeManager));
  const registry = Option.getOrNull(yield* Effect.serviceOption(WorkspaceRegistry));
  const registeredWorkspaces = registry === null ? [] : (yield* registry.state).workspaces;
  const slack = yield* SlackWrite;
  const observationStore = yield* TriggerObservationStore;
  const recordArtifact = (artifact: WorkflowActionPlanArtifact | null) =>
    Schema.is(WorkflowActionArtifact)(artifact) ? artifacts.record(artifact) : Effect.void;
  const coordinationView = yield* coordination.read(admission.event.key);
  const handbackAfterPlan = coordinationView.barrierAtMillis > initial.createdAtMillis;
  const hasFreshHandback =
    coordinationView.barrierAtMillis > Math.max(initial.createdAtMillis, initial.consumedHandbackAtMillis);
  const hasFailedWrite = initial.steps.some(({ status }) => status === "failed");
  if (hasFailedWrite && !hasFreshHandback) return { _tag: "Parked" } as const;
  const executingDraft = initial.steps.find(
    ({ entry, status }) => entry === "slack.draft-reply-in-slack" && status === "executing",
  );
  if (executingDraft) {
    yield* coordination.park(admission.event.key, {
      _tag: "DraftOutcomeUnknown",
      step: executingDraft.entry,
    });
    const plan = replaceStep(initial, executingDraft, { status: "failed" });
    yield* store.save(plan);
    return { _tag: "Parked" } as const;
  }
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
    yield* coordination.park(
      admission.event.key,
      {
        _tag: "AwaitingApproval",
        plan: initial.attempt,
        digest: initial.digest,
        revision: initial.revision,
      },
      { workflow: initial.workflow, operation: initial.operation },
    );
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
        const executingPlan =
          step.entry === "slack.draft-reply-in-slack"
            ? replaceStep(state.plan, step, { status: "executing" })
            : state.plan;
        if (executingPlan !== state.plan) yield* store.save(executingPlan);
        const executingStep = executingPlan.steps.find(({ position }) => position === step.position) ?? step;
        const workspace = targetWorkspace(executingStep);
        const sourceWorkspace = sourceTargetWorkspace(executingStep, registeredWorkspaces);
        const context = {
          item: admission.event.key,
          plan: executingPlan,
          step: executingStep,
          workspace,
          tracker,
          notifications,
          ledger,
          sourceControl,
          sourceWorkspace,
          worktrees,
          slack,
          actionPlans: store,
          coordination,
          observationStore,
        };
        const result = yield* Effect.result(executor(context).pipe(Effect.tap(recordArtifact)));
        if (result._tag === "Success") {
          const plan = replaceStep(executingPlan, executingStep, {
            status: "completed",
            artifact: result.success,
          });
          yield* store.save(plan);
          return initialExecutionState(plan);
        }
        const error = result.failure;
        if (error._tag === "SlackWriteError" && error.reason === "draft-outcome-unknown") {
          yield* coordination.park(admission.event.key, {
            _tag: "DraftOutcomeUnknown",
            step: executingStep.entry,
          });
          const plan = replaceStep(executingPlan, executingStep, { status: "failed" });
          yield* store.save(plan);
          return { plan, result: { _tag: "Parked" } } satisfies ExecutionState;
        }
        const failures = executingStep.failures + 1;
        const permanent =
          error._tag === "IssueTrackerError" ? issueTrackerErrorIsPermanent(error) : !error.retryable;
        const parked = permanent || failures >= 3;
        const updated = replaceStep(executingPlan, executingStep, {
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
