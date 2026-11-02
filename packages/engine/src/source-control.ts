import type {
  WorkflowActionArtifact,
  WorkflowActionOrigin,
  WorkflowReviewComment,
  WorkItem,
  WorkItemId,
  WorkItemRef,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ObservedPr } from "./follow-up";
import { IssueTrackerError } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import type { TriggerSource } from "./trigger-source";
import type { WorkflowCatalogContribution } from "./workflow-catalog";

// Everything the provider can learn about a pull request by reading it. The follow-up marker is the
// tracker's coordination state, not the PR's, so it is attached during composition rather than here.
export type PrSignals = Omit<ObservedPr, "followUp">;

export interface OpenPullRequestInput {
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly title: string;
  readonly body: string;
}

export interface OpenedPullRequest {
  readonly number: number;
  readonly url: string;
}

export interface ResolvedPullRequest extends OpenedPullRequest {
  readonly headBranch: string;
  readonly baseBranch: string;
}

export interface PullRequestChangedFile {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly patch: string | null;
}

export interface PullRequestComment {
  readonly author: string;
  readonly body: string;
  readonly path: string | null;
  readonly line: number | null;
}

export interface PullRequestContext extends ResolvedPullRequest {
  readonly headSha: string;
  readonly title: string;
  readonly description: string;
  readonly diff: string;
  readonly changedFiles: ReadonlyArray<PullRequestChangedFile>;
  readonly comments: ReadonlyArray<PullRequestComment>;
}

export type PullRequestReviewEvent = "approve" | "comment" | "request-changes";

export interface PullRequestReviewInput {
  readonly body: string;
  readonly comments: ReadonlyArray<WorkflowReviewComment>;
  readonly commitId: string;
}

export interface WorkflowPullRequestInput extends OpenPullRequestInput {
  readonly origin: WorkflowActionOrigin;
}

export interface SourceControlProviderService {
  readonly triggerSources?: ReadonlyArray<TriggerSource>;
  readonly workflowCatalogContribution: WorkflowCatalogContribution;
  readonly observe: (
    workspace: RegisteredWorkspace,
    workItems: ReadonlyArray<WorkItem>,
  ) => Effect.Effect<ReadonlyMap<WorkItemId, PrSignals>, IssueTrackerError>;

  // Post the daemon's round summary as a comment on the item's pull request. The provider appends
  // its own coordination marker, so the engine — never the agent — owns the marker, and a comment
  // written here is never read back as human feedback. A no-op when the item has no linked PR.
  readonly comment: (
    workspace: RegisteredWorkspace,
    item: WorkItem,
    body: string,
  ) => Effect.Effect<void, IssueTrackerError>;

  readonly findOpenPullRequest: (
    workspace: RegisteredWorkspace,
    headBranch: string,
  ) => Effect.Effect<OpenedPullRequest | null, IssueTrackerError>;

  readonly openPullRequest: (
    workspace: RegisteredWorkspace,
    input: OpenPullRequestInput,
  ) => Effect.Effect<OpenedPullRequest, IssueTrackerError>;
  readonly resolvePullRequest: (
    workspace: RegisteredWorkspace,
    item: WorkItemRef,
  ) => Effect.Effect<ResolvedPullRequest | null, IssueTrackerError>;
  readonly readPullRequest: (
    workspace: RegisteredWorkspace,
    reference: string,
  ) => Effect.Effect<PullRequestContext | null, IssueTrackerError>;
  readonly openWorkflowPullRequest: (
    workspace: RegisteredWorkspace,
    input: WorkflowPullRequestInput,
  ) => Effect.Effect<WorkflowActionArtifact, IssueTrackerError>;
  readonly recordPullRequestPush: (
    workspace: RegisteredWorkspace,
    pullRequest: ResolvedPullRequest,
    origin: WorkflowActionOrigin,
  ) => Effect.Effect<WorkflowActionArtifact, IssueTrackerError>;
  readonly commentPullRequest: (
    workspace: RegisteredWorkspace,
    pullRequest: ResolvedPullRequest,
    body: string,
    origin: WorkflowActionOrigin,
  ) => Effect.Effect<WorkflowActionArtifact, IssueTrackerError>;
  readonly requestReview: (
    workspace: RegisteredWorkspace,
    pullRequest: ResolvedPullRequest,
    reviewer: string,
    origin: WorkflowActionOrigin,
  ) => Effect.Effect<WorkflowActionArtifact, IssueTrackerError>;
  readonly commentNamedPullRequest: (
    workspace: RegisteredWorkspace,
    pullRequest: ResolvedPullRequest,
    body: string,
    origin: WorkflowActionOrigin,
  ) => Effect.Effect<WorkflowActionArtifact, IssueTrackerError>;
  readonly postReview: (
    workspace: RegisteredWorkspace,
    pullRequest: ResolvedPullRequest,
    event: PullRequestReviewEvent,
    input: PullRequestReviewInput,
    origin: WorkflowActionOrigin,
  ) => Effect.Effect<WorkflowActionArtifact, IssueTrackerError>;
  readonly draftReview: (
    workspace: RegisteredWorkspace,
    pullRequest: ResolvedPullRequest,
    input: PullRequestReviewInput,
    origin: WorkflowActionOrigin,
  ) => Effect.Effect<WorkflowActionArtifact, IssueTrackerError>;
}

export class SourceControlProvider extends Context.Service<
  SourceControlProvider,
  SourceControlProviderService
>()("@cogwork/engine/source-control/SourceControlProvider") {}

export const emptyService: SourceControlProviderService = {
  workflowCatalogContribution: { entries: [], templates: [] },
  observe: () => Effect.succeed(new Map()),
  comment: () => Effect.void,
  findOpenPullRequest: () => Effect.succeed(null),
  openPullRequest: () =>
    Effect.fail(
      new IssueTrackerError({
        reason: "unavailable",
        retryable: false,
        message: "source control provider is not configured",
      }),
    ),
  resolvePullRequest: () => Effect.succeed(null),
  readPullRequest: () => Effect.succeed(null),
  openWorkflowPullRequest: () =>
    Effect.fail(
      new IssueTrackerError({
        reason: "unavailable",
        retryable: false,
        message: "source control provider is not configured",
      }),
    ),
  recordPullRequestPush: () =>
    Effect.fail(
      new IssueTrackerError({
        reason: "unavailable",
        retryable: false,
        message: "source control provider is not configured",
      }),
    ),
  commentPullRequest: () =>
    Effect.fail(
      new IssueTrackerError({
        reason: "unavailable",
        retryable: false,
        message: "source control provider is not configured",
      }),
    ),
  requestReview: () =>
    Effect.fail(
      new IssueTrackerError({
        reason: "unavailable",
        retryable: false,
        message: "source control provider is not configured",
      }),
    ),
  commentNamedPullRequest: () =>
    Effect.fail(
      new IssueTrackerError({
        reason: "unavailable",
        retryable: false,
        message: "source control provider is not configured",
      }),
    ),
  postReview: () =>
    Effect.fail(
      new IssueTrackerError({
        reason: "unavailable",
        retryable: false,
        message: "source control provider is not configured",
      }),
    ),
  draftReview: () =>
    Effect.fail(
      new IssueTrackerError({
        reason: "unavailable",
        retryable: false,
        message: "source control provider is not configured",
      }),
    ),
};

// The binding for a workspace with no source control provider — a Linear tracker with no
// `sourceControl` block. It reports no pull request for any item.
export const emptyLayer = Layer.succeed(SourceControlProvider, emptyService);
