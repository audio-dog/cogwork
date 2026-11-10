import { createHash } from "node:crypto";
import {
  issueTrackerErrorIsPermanent,
  keyOf,
  matchWorkflowTransitions,
  type RunId,
  SlackWriteKey,
  SourceControlType,
  WorkflowActionArtifact,
  WorkflowActionOrigin,
  WorkflowActionPlan,
  WorkflowActionPlanStep,
  WorkflowActionTarget,
  type WorkflowAgentInputValue,
  type WorkflowCatalog,
  type WorkflowCatalogEntry,
  type WorkflowDocument,
  type WorkflowNodeId,
  type WorkflowOperation,
  type WorkflowParameterValue,
  type WorkflowReviewComment,
  WorkflowSlackActionArtifact,
  WorkItemId,
  WorkItemRef,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Coordination } from "./coordination";
import { IssueTracker, IssueTrackerError } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { WorkspaceRegistry } from "./registry";
import { RunLedger } from "./run-ledger";
import { type SlackPostReceipt, SlackWrite, SlackWriteError } from "./slack-write";
import {
  type PullRequestContext,
  type PullRequestReviewEvent,
  SourceControlProvider,
  type SourceControlProviderService,
} from "./source-control";
import { type TriggerAdmission, TriggerObservationStore } from "./trigger-observation";
import {
  type ActionContext,
  type ActionExecutor,
  decodeFailure,
  invalidTarget,
  itemWorkspaceOf,
  parameterValues,
  stringInput,
  type TargetProducer,
  WorkflowActionPlanDecodeError,
} from "./workflow-action-entry";
import { WorkflowActionPlanStore } from "./workflow-action-plan-store";
import { actionEntryFor, compareActionPhase } from "./workflow-action-registry";
import {
  commentIssue,
  type FrozenIssueTarget,
  frozenIssueTarget,
  requireWorkspace,
  targetFields,
} from "./workflow-actions-issue";
import { WorkflowArtifactStore } from "./workflow-artifact-store";
import { WorkflowNotifications } from "./workflow-notification";
import { PullRequestReadiness, WorktreeManager } from "./worktree";

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
  readonly pullRequestSnapshots?: ReadonlyArray<{
    readonly workspace: string;
    readonly pullRequest: PullRequestContext;
  }>;
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
    Effect.mapError(() => WorkflowActionPlanDecodeError.make({ message: "Action plan encoding failed" })),
  );
  return createHash("sha256").update(encoded).digest("hex");
});

type FrozenSourceControlTarget = Pick<RegisteredWorkspace, "repository"> & {
  readonly app: SourceControlType;
  readonly config: Pick<RegisteredWorkspace["config"], "name" | "issueTracker" | "sourceControl">;
};

const githubSourceControlType = Schema.decodeSync(SourceControlType)("github");

const sourceControlTargetFields = (target: FrozenSourceControlTarget) => ({
  workspace: target.config.name,
  app: target.app,
  issueTracker: target.config.issueTracker,
  ...(target.config.sourceControl ? { sourceControl: target.config.sourceControl } : {}),
  repository: target.repository ?? null,
});

const frozenSourceControlTarget = Effect.fn("WorkflowActionPlan.frozenSourceControlTarget")(function* (
  entry: WorkflowCatalogEntry,
  selected: ReadonlyArray<RegisteredWorkspace>,
  workspaceId: string | undefined,
) {
  if (workspaceId === "none") return null;
  if (workspaceId === undefined) return yield* decodeFailure(`Action ${entry.key} needs a Workspace`);
  const workspace = selected.find(({ config }) => config.name === workspaceId);
  const app = workspace?.config.sourceControl?.type ?? workspace?.config.issueTracker.type;
  if (entry.system !== "github" || app !== "github" || !workspace) {
    return yield* decodeFailure(`Workspace ${workspaceId} does not bind ${entry.system ?? "the action app"}`);
  }
  return {
    app: githubSourceControlType,
    config: {
      name: workspace.config.name,
      issueTracker: workspace.config.issueTracker,
      ...(workspace.config.sourceControl ? { sourceControl: workspace.config.sourceControl } : {}),
    },
    repository: workspace.repository,
  } satisfies FrozenSourceControlTarget;
});

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

type IssueTargetProducer = (
  admission: TriggerAdmission,
  target: FrozenIssueTarget | null,
  inputs: Readonly<Record<string, WorkflowAgentInputValue>>,
) => Effect.Effect<WorkflowActionTarget, WorkflowActionPlanDecodeError>;

const issueTargetProducers = new Map<string, IssueTargetProducer>([
  [
    "create-issue",
    (
      _admission: TriggerAdmission,
      target: FrozenIssueTarget | null,
      _inputs: Readonly<Record<string, WorkflowAgentInputValue>>,
    ) =>
      Effect.succeed<WorkflowActionTarget>(
        target === null ? { _tag: "NoWorkspace" } : { _tag: "NewIssue", ...targetFields(target) },
      ),
  ],
  [
    "comment-issue",
    (
      _admission: TriggerAdmission,
      target: FrozenIssueTarget | null,
      inputs: Readonly<Record<string, WorkflowAgentInputValue>>,
    ) => existingIssueTarget(typeof inputs.issue === "string" ? inputs.issue : "", target),
  ],
]);

const sourceControlActions = new Set([
  "open-pull-request",
  "push-to-this-pull-request",
  "comment-on-this-pull-request",
  "request-review",
  "comment-on-named-pull-request",
  "post-review",
  "draft-review",
]);

const namedPullRequestActions = new Set(["comment-on-named-pull-request", "post-review", "draft-review"]);

interface DiffLineState {
  inHunk: boolean;
  newLine: number;
  readonly lines: Set<number>;
}

const diffNewSideLines = (patch: string) =>
  patch.split("\n").reduce<DiffLineState>(
    (state, line) => {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        state.inHunk = true;
        state.newLine = Number(hunk[1]);
        return state;
      }
      if (!state.inHunk || line.startsWith("\\")) return state;
      if (line.startsWith("-")) return state;
      state.lines.add(state.newLine);
      state.newLine += 1;
      return state;
    },
    { inHunk: false, newLine: 0, lines: new Set() },
  ).lines;

const reviewCommentFailure = (comment: WorkflowReviewComment, pullRequest: PullRequestContext) => {
  const fileIsChanged = pullRequest.changedFiles.some(({ path }) => path === comment.path);
  const fileDiff = pullRequest.diff
    .split(/(?=^diff --git )/m)
    .find((section) => section.split("\n").includes(`+++ b/${comment.path}`));
  const lineIsInDiff = fileIsChanged && fileDiff ? diffNewSideLines(fileDiff).has(comment.line) : false;
  return lineIsInDiff
    ? null
    : `Review comment ${comment.path}:${comment.line} is not on the new side of the diff`;
};

const sourceControlTargetFor = Effect.fn("WorkflowActionPlan.sourceControlTargetFor")(function* (
  entry: WorkflowCatalogEntry,
  admission: TriggerAdmission,
  selected: ReadonlyArray<RegisteredWorkspace>,
  inputs: Readonly<Record<string, WorkflowAgentInputValue>>,
  sourceControl: SourceControlProviderService | undefined,
  workspaceId: string | undefined,
  snapshots:
    | ReadonlyArray<{ readonly workspace: string; readonly pullRequest: PullRequestContext }>
    | undefined,
) {
  const name = actionName(entry.key);
  const named = namedPullRequestActions.has(name);
  const target = yield* frozenSourceControlTarget(
    entry,
    selected,
    named ? workspaceId : (itemWorkspaceOf(admission) ?? workspaceId),
  );
  if (target === null) return { _tag: "NoWorkspace" } as const;
  if (named) {
    const reference = typeof inputs.pull_request === "string" ? inputs.pull_request : "";
    const workspace = selected.find(({ config }) => config.name === target.config.name);
    if (!workspace) return yield* decodeFailure("The named pull request Workspace is unavailable");
    if (!sourceControl) return yield* decodeFailure("Source control provider is not configured");
    const currentPullRequest = yield* sourceControl
      .readPullRequest(workspace, reference)
      .pipe(Effect.mapError((error) => WorkflowActionPlanDecodeError.make({ message: error.message })));
    if (currentPullRequest === null) return yield* decodeFailure(`Pull request ${reference} was not found`);
    const snapshot = snapshots?.findLast(
      ({ workspace: snapshotWorkspace, pullRequest }) =>
        snapshotWorkspace === workspace.config.name && pullRequest.number === currentPullRequest.number,
    );
    if (snapshots && !snapshot) {
      return yield* decodeFailure(`Read pull request ${reference} with the pull-request Tool`);
    }
    if (snapshot && snapshot.pullRequest.headSha !== currentPullRequest.headSha) {
      return yield* decodeFailure(`Pull request ${reference} received a new commit after it was read`);
    }
    const pullRequest = snapshot?.pullRequest ?? currentPullRequest;
    const comments = Array.isArray(inputs.review_comments) ? inputs.review_comments : [];
    const failure = comments.map((comment) => reviewCommentFailure(comment, pullRequest)).find(Boolean);
    if (failure) return yield* decodeFailure(failure);
    return {
      _tag: "NamedPullRequest",
      ...sourceControlTargetFields(target),
      number: pullRequest.number,
      url: pullRequest.url,
      headBranch: pullRequest.headBranch,
      baseBranch: pullRequest.baseBranch,
      headSha: pullRequest.headSha,
    } as const;
  }
  const item = admission.event.key;
  if (name === "open-pull-request") {
    if (item._tag !== "Issue" || item.workspace !== target.config.name) {
      return yield* decodeFailure("Open a pull request needs an Issue in the selected Workspace");
    }
    return {
      _tag: "NewPullRequest",
      ...sourceControlTargetFields(target),
      issue: item.id,
    } as const;
  }
  if ((item._tag !== "Issue" && item._tag !== "PullRequest") || item.workspace !== target.config.name) {
    return yield* decodeFailure("The action cannot target this pull request in the selected Workspace");
  }
  return {
    _tag: "CurrentPullRequest",
    ...sourceControlTargetFields(target),
    item,
  } as const;
});

const cogworkTarget = Effect.succeed<WorkflowActionTarget>({ _tag: "Cogwork" });

const issueTargetProducer =
  (producer: IssueTargetProducer): TargetProducer =>
  (context) =>
    frozenIssueTarget(context.entry, context.workspaces, context.workspace).pipe(
      Effect.flatMap((target) => producer(context.admission, target, context.inputs)),
    );

const decodeSlackTarget = Schema.decodeUnknownEffect(WorkflowActionTarget);

const slackTarget = (target: unknown) =>
  decodeSlackTarget(target).pipe(
    Effect.mapError(() => WorkflowActionPlanDecodeError.make({ message: "The Slack target is invalid" })),
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
  ...[...issueTargetProducers].map(([name, producer]) => [name, issueTargetProducer(producer)] as const),
  ["send-message", slackChannelTarget],
  ["reply-in-thread", slackItemTarget],
  ["add-reaction", slackItemTarget],
  ["draft-reply-in-slack", slackItemTarget],
]);

const targetFor = (
  entry: WorkflowCatalogEntry,
  admission: TriggerAdmission,
  workspaces: ReadonlyArray<RegisteredWorkspace>,
  inputs: Readonly<Record<string, WorkflowAgentInputValue>>,
  parameters: ReadonlyArray<WorkflowParameterValue>,
  sourceControl: SourceControlProviderService | undefined,
  workspace: string | undefined,
  snapshots:
    | ReadonlyArray<{ readonly workspace: string; readonly pullRequest: PullRequestContext }>
    | undefined,
) => {
  const context = { entry, admission, workspaces, inputs, parameters, workspace, sourceControl };
  const registered = actionEntryFor(entry.key);
  if (registered) return registered.target(context);
  const name = actionName(entry.key);
  if (sourceControlActions.has(name)) {
    return sourceControlTargetFor(entry, admission, workspaces, inputs, sourceControl, workspace, snapshots);
  }
  return targetProducers.get(name)?.(context) ?? cogworkTarget;
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
      const target = yield* targetFor(
        entry,
        input.admission,
        workspaces,
        inputs,
        action.parameters,
        input.sourceControl,
        input.output.workspace,
        input.pullRequestSnapshots,
      );
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

const reviewCommentsInput = (step: WorkflowActionPlanStep) => {
  const value = step.inputs.review_comments;
  return Array.isArray(value) ? value : [];
};

const reviewEvents: ReadonlyMap<string, PullRequestReviewEvent> = new Map([
  ["approve", "approve"],
  ["comment", "comment"],
  ["request-changes", "request-changes"],
] as const);

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

const requireSourceWorkspace = (context: ActionContext) =>
  context.sourceWorkspace === null
    ? Effect.fail(invalidTarget(context.step))
    : Effect.succeed(context.sourceWorkspace);

const requireSourceControl = (context: ActionContext) =>
  context.sourceControl === null
    ? Effect.fail(invalidTarget(context.step))
    : Effect.succeed(context.sourceControl);

const requireWorktrees = (context: ActionContext) =>
  context.worktrees === null ? Effect.fail(invalidTarget(context.step)) : Effect.succeed(context.worktrees);

const actionOrigin = (context: ActionContext) =>
  WorkflowActionOrigin.make({
    item: context.plan.item,
    workflow: context.plan.workflow,
    attempt: context.plan.attempt,
    writeKey: context.step.writeKey,
    lineage: context.plan.lineage,
  });

const requirePullRequest = Effect.fn("WorkflowActionPlan.requirePullRequest")(function* (
  context: ActionContext,
) {
  const workspace = yield* requireSourceWorkspace(context);
  const sourceControl = yield* requireSourceControl(context);
  if (context.step.target._tag === "NamedPullRequest") {
    return {
      workspace,
      pullRequest: {
        number: context.step.target.number,
        url: context.step.target.url,
        headBranch: context.step.target.headBranch,
        baseBranch: context.step.target.baseBranch,
      },
    };
  }
  if (context.step.target._tag !== "CurrentPullRequest") return yield* invalidTarget(context.step);
  const pullRequest = yield* sourceControl.resolvePullRequest(workspace, context.step.target.item);
  if (pullRequest === null) return yield* invalidTarget(context.step);
  return { workspace, pullRequest };
});

const worktreeError = (message: string, retryable: boolean) =>
  new IssueTrackerError({ reason: "unavailable", message, retryable });

const actionExecutors: Record<string, ActionExecutor> = {
  "create-issue": Effect.fn("WorkflowActionPlan.createIssue")(function* (context: ActionContext) {
    const workspace = yield* requireWorkspace(context);
    if (context.step.target._tag !== "NewIssue") return yield* invalidTarget(context.step);
    return yield* context.tracker.createIssue(workspace, {
      title: stringInput(context.step, "issue_title"),
      body: stringInput(context.step, "issue_body"),
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
  "comment-issue": commentIssue,
  "open-pull-request": Effect.fn("WorkflowActionPlan.openPullRequest")(function* (context: ActionContext) {
    const workspace = yield* requireSourceWorkspace(context);
    const sourceControl = yield* requireSourceControl(context);
    const worktrees = yield* requireWorktrees(context);
    if (context.step.target._tag !== "NewPullRequest") return yield* invalidTarget(context.step);
    const run = yield* context.ledger.getRun(context.plan.attempt);
    if (run?.branch === null || run?.branch === undefined) return yield* invalidTarget(context.step);
    const item = { id: context.step.target.issue, title: "" };
    const readiness = yield* worktrees
      .pullRequestReadiness(workspace, item, run.branch)
      .pipe(Effect.mapError((error) => worktreeError(error.message, error.retryable)));
    if (PullRequestReadiness.$is("Declined")(readiness)) {
      return yield* worktreeError(readiness.reason, true);
    }
    yield* worktrees
      .pushBranch(workspace, readiness.headBranch)
      .pipe(Effect.mapError((error) => worktreeError(error.message, error.retryable)));
    return yield* sourceControl.openWorkflowPullRequest(workspace, {
      headBranch: readiness.headBranch,
      baseBranch: readiness.baseBranch,
      title: stringInput(context.step, "pr_title"),
      body: stringInput(context.step, "pr_body"),
      origin: actionOrigin(context),
    });
  }),
  "push-to-this-pull-request": Effect.fn("WorkflowActionPlan.pushPullRequest")(function* (
    context: ActionContext,
  ) {
    const { workspace, pullRequest } = yield* requirePullRequest(context);
    const sourceControl = yield* requireSourceControl(context);
    const worktrees = yield* requireWorktrees(context);
    const pushed = yield* worktrees
      .pushBranchIfAhead(workspace, pullRequest.headBranch)
      .pipe(Effect.mapError((error) => worktreeError(error.message, error.retryable)));
    if (!pushed) return null;
    return yield* sourceControl.recordPullRequestPush(workspace, pullRequest, actionOrigin(context));
  }),
  "comment-on-this-pull-request": Effect.fn("WorkflowActionPlan.commentPullRequest")(function* (
    context: ActionContext,
  ) {
    const { workspace, pullRequest } = yield* requirePullRequest(context);
    const sourceControl = yield* requireSourceControl(context);
    return yield* sourceControl.commentPullRequest(
      workspace,
      pullRequest,
      stringInput(context.step, "comment"),
      actionOrigin(context),
    );
  }),
  "request-review": Effect.fn("WorkflowActionPlan.requestReview")(function* (context: ActionContext) {
    const { workspace, pullRequest } = yield* requirePullRequest(context);
    const sourceControl = yield* requireSourceControl(context);
    const reviewer = parameterValues(context.step.parameters, "reviewer").at(0);
    if (!reviewer) return yield* invalidTarget(context.step);
    return yield* sourceControl.requestReview(workspace, pullRequest, reviewer, actionOrigin(context));
  }),
  "comment-on-named-pull-request": Effect.fn("WorkflowActionPlan.commentNamedPullRequest")(function* (
    context: ActionContext,
  ) {
    const { workspace, pullRequest } = yield* requirePullRequest(context);
    const sourceControl = yield* requireSourceControl(context);
    return yield* sourceControl.commentNamedPullRequest(
      workspace,
      pullRequest,
      stringInput(context.step, "comment_body"),
      actionOrigin(context),
    );
  }),
  "post-review": Effect.fn("WorkflowActionPlan.postReview")(function* (context: ActionContext) {
    const { workspace, pullRequest } = yield* requirePullRequest(context);
    const sourceControl = yield* requireSourceControl(context);
    if (context.step.target._tag !== "NamedPullRequest") return yield* invalidTarget(context.step);
    const event = reviewEvents.get(parameterValues(context.step.parameters, "event").at(0) ?? "");
    if (!event) return yield* invalidTarget(context.step);
    return yield* sourceControl.postReview(
      workspace,
      pullRequest,
      event,
      {
        body: stringInput(context.step, "review_body"),
        comments: reviewCommentsInput(context.step),
        commitId: context.step.target.headSha,
      },
      actionOrigin(context),
    );
  }),
  "draft-review": Effect.fn("WorkflowActionPlan.draftReview")(function* (context: ActionContext) {
    const { workspace, pullRequest } = yield* requirePullRequest(context);
    const sourceControl = yield* requireSourceControl(context);
    if (context.step.target._tag !== "NamedPullRequest") return yield* invalidTarget(context.step);
    return yield* sourceControl.draftReview(
      workspace,
      pullRequest,
      {
        body: stringInput(context.step, "review_body"),
        comments: reviewCommentsInput(context.step),
        commitId: context.step.target.headSha,
      },
      actionOrigin(context),
    );
  }),
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
        const result = yield* Effect.result(executor(context));
        if (result._tag === "Success") {
          const plan = replaceStep(executingPlan, executingStep, {
            status: "completed",
            artifact: result.success,
          });
          if (Schema.is(WorkflowActionArtifact)(result.success)) yield* artifacts.record(result.success);
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
