import {
  SourceControlType,
  WorkflowActionOrigin,
  type WorkflowActionPlanStep,
  type WorkflowActionTarget,
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  type WorkflowReviewComment,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IssueTrackerError } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import type { PullRequestContext, PullRequestReviewEvent } from "./source-control";
import {
  type ActionContext,
  type ActionEntry,
  type ActionExecutor,
  decodeFailure,
  type EngineToolName,
  invalidTarget,
  itemWorkspaceOf,
  parameterValues,
  stringInput,
  type TargetContext,
  type TargetProducer,
  WorkflowActionPlanDecodeError,
} from "./workflow-action-entry";
import { PullRequestReadiness } from "./worktree";

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

const itemSourceControlTarget = (context: TargetContext) =>
  frozenSourceControlTarget(
    context.entry,
    context.workspaces,
    itemWorkspaceOf(context.admission) ?? context.workspace,
  );

const newPullRequestTarget = Effect.fn("WorkflowActionPlan.newPullRequestTarget")(function* (
  context: TargetContext,
) {
  const target = yield* itemSourceControlTarget(context);
  if (target === null) return { _tag: "NoWorkspace" } satisfies WorkflowActionTarget;
  const item = context.admission.event.key;
  if (item._tag !== "Issue" || item.workspace !== target.config.name) {
    return yield* decodeFailure("Open a pull request needs an Issue in the selected Workspace");
  }
  return {
    _tag: "NewPullRequest",
    ...sourceControlTargetFields(target),
    issue: item.id,
  } satisfies WorkflowActionTarget;
});

const currentPullRequestTarget = Effect.fn("WorkflowActionPlan.currentPullRequestTarget")(function* (
  context: TargetContext,
) {
  const target = yield* itemSourceControlTarget(context);
  if (target === null) return { _tag: "NoWorkspace" } satisfies WorkflowActionTarget;
  const item = context.admission.event.key;
  if ((item._tag !== "Issue" && item._tag !== "PullRequest") || item.workspace !== target.config.name) {
    return yield* decodeFailure("The action cannot target this pull request in the selected Workspace");
  }
  return {
    _tag: "CurrentPullRequest",
    ...sourceControlTargetFields(target),
    item,
  } satisfies WorkflowActionTarget;
});

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

const namedPullRequestTarget = Effect.fn("WorkflowActionPlan.namedPullRequestTarget")(function* (
  context: TargetContext,
) {
  const { inputs, sourceControl, pullRequestSnapshots: snapshots } = context;
  const target = yield* frozenSourceControlTarget(context.entry, context.workspaces, context.workspace);
  if (target === null) return { _tag: "NoWorkspace" } satisfies WorkflowActionTarget;
  const reference = typeof inputs.pull_request === "string" ? inputs.pull_request : "";
  const workspace = context.workspaces.find(({ config }) => config.name === target.config.name);
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
  } satisfies WorkflowActionTarget;
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

const openPullRequest = Effect.fn("WorkflowActionPlan.openPullRequest")(function* (context: ActionContext) {
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
});

const pushPullRequest = Effect.fn("WorkflowActionPlan.pushPullRequest")(function* (context: ActionContext) {
  const { workspace, pullRequest } = yield* requirePullRequest(context);
  const sourceControl = yield* requireSourceControl(context);
  const worktrees = yield* requireWorktrees(context);
  const pushed = yield* worktrees
    .pushBranchIfAhead(workspace, pullRequest.headBranch)
    .pipe(Effect.mapError((error) => worktreeError(error.message, error.retryable)));
  if (!pushed) return null;
  return yield* sourceControl.recordPullRequestPush(workspace, pullRequest, actionOrigin(context));
});

const commentPullRequest = Effect.fn("WorkflowActionPlan.commentPullRequest")(function* (
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
});

const requestReview = Effect.fn("WorkflowActionPlan.requestReview")(function* (context: ActionContext) {
  const { workspace, pullRequest } = yield* requirePullRequest(context);
  const sourceControl = yield* requireSourceControl(context);
  const reviewer = parameterValues(context.step.parameters, "reviewer").at(0);
  if (!reviewer) return yield* invalidTarget(context.step);
  return yield* sourceControl.requestReview(workspace, pullRequest, reviewer, actionOrigin(context));
});

const commentNamedPullRequest = Effect.fn("WorkflowActionPlan.commentNamedPullRequest")(function* (
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
});

const reviewEvents: ReadonlyMap<string, PullRequestReviewEvent> = new Map([
  ["approve", "approve"],
  ["comment", "comment"],
  ["request-changes", "request-changes"],
] as const);

const reviewInput = (step: WorkflowActionPlanStep, commitId: string) => {
  const comments = step.inputs.review_comments;
  return {
    body: stringInput(step, "review_body"),
    comments: Array.isArray(comments) ? comments : [],
    commitId,
  };
};

const postReview = Effect.fn("WorkflowActionPlan.postReview")(function* (context: ActionContext) {
  const { workspace, pullRequest } = yield* requirePullRequest(context);
  const sourceControl = yield* requireSourceControl(context);
  if (context.step.target._tag !== "NamedPullRequest") return yield* invalidTarget(context.step);
  const event = reviewEvents.get(parameterValues(context.step.parameters, "event").at(0) ?? "");
  if (!event) return yield* invalidTarget(context.step);
  return yield* sourceControl.postReview(
    workspace,
    pullRequest,
    event,
    reviewInput(context.step, context.step.target.headSha),
    actionOrigin(context),
  );
});

const draftReview = Effect.fn("WorkflowActionPlan.draftReview")(function* (context: ActionContext) {
  const { workspace, pullRequest } = yield* requirePullRequest(context);
  const sourceControl = yield* requireSourceControl(context);
  if (context.step.target._tag !== "NamedPullRequest") return yield* invalidTarget(context.step);
  return yield* sourceControl.draftReview(
    workspace,
    pullRequest,
    reviewInput(context.step, context.step.target.headSha),
    actionOrigin(context),
  );
});

const reviewerParameter = {
  id: "reviewer",
  required: true,
  source: "live",
  values: [],
} satisfies WorkflowCatalogEntry["parameters"][number];

const reviewEventParameter = {
  id: "event",
  required: true,
  source: "fixed",
  values: ["approve", "comment", "request-changes"],
} satisfies WorkflowCatalogEntry["parameters"][number];

const sourceControlActionRow = (
  id: string,
  name: string,
  permissionProfile: WorkflowCatalogEntry["permissionProfile"],
  agentInputs: ReadonlyArray<string>,
  parameters: WorkflowCatalogEntry["parameters"] = [],
  actsOn: ReadonlyArray<string> = ["issue", "pull-request"],
) =>
  ({
    key: Schema.decodeSync(WorkflowCatalogKey)(`github.${id}`),
    name,
    kind: "action",
    system: "github",
    connection: "github",
    requires: [],
    parameters,
    itemKind: null,
    actsOn,
    requiresWorkspace: true,
    permissionProfile,
    agentInputs,
    emits: [],
  }) satisfies WorkflowCatalogEntry;

const sourceControlEntry = (
  row: WorkflowCatalogEntry,
  target: TargetProducer,
  execute: ActionExecutor,
  tools: ReadonlyArray<EngineToolName> = [],
): ActionEntry => ({ row, target, execute, phase: "write", tools });

const currentPullRequestEntry = (row: WorkflowCatalogEntry, execute: ActionExecutor) =>
  sourceControlEntry(row, currentPullRequestTarget, execute);

const namedPullRequestEntry = (row: WorkflowCatalogEntry, execute: ActionExecutor) =>
  sourceControlEntry(row, namedPullRequestTarget, execute, ["pull-request"]);

const reviewInputs = ["pull_request", "review_body", "review_comments"];

export const sourceControlActionEntries = [
  sourceControlEntry(
    sourceControlActionRow(
      "open-pull-request",
      "Open a pull request",
      "full",
      ["pr_title", "pr_body"],
      [],
      ["issue"],
    ),
    newPullRequestTarget,
    openPullRequest,
  ),
  currentPullRequestEntry(
    sourceControlActionRow("push-to-this-pull-request", "Push to this pull request", "full", []),
    pushPullRequest,
  ),
  currentPullRequestEntry(
    sourceControlActionRow("comment-on-this-pull-request", "Comment on this pull request", "read-only", [
      "comment",
    ]),
    commentPullRequest,
  ),
  currentPullRequestEntry(
    sourceControlActionRow("request-review", "Request a review", "read-only", [], [reviewerParameter]),
    requestReview,
  ),
  namedPullRequestEntry(
    sourceControlActionRow(
      "comment-on-named-pull-request",
      "Comment on a named pull request",
      "read-only",
      ["pull_request", "comment_body"],
      [],
      ["*"],
    ),
    commentNamedPullRequest,
  ),
  namedPullRequestEntry(
    sourceControlActionRow(
      "post-review",
      "Post a review",
      "read-only",
      reviewInputs,
      [reviewEventParameter],
      ["*"],
    ),
    postReview,
  ),
  namedPullRequestEntry(
    sourceControlActionRow("draft-review", "Draft a review", "read-only", reviewInputs, [], ["*"]),
    draftReview,
  ),
];
