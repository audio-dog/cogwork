import type {
  PrSummary,
  ReadyToMergeItem,
  WorkflowActionArtifact,
  WorkflowActionOrigin,
  WorkflowReviewComment,
  WorkItemRef,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { IssueTrackerError } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import type { TriggerSource } from "./trigger-source";
import type { WorkflowCatalogContribution } from "./workflow-catalog";

export type PrSignals = PrSummary & { readonly draft: boolean };

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
  readonly readyToMerge: (
    workspace: RegisteredWorkspace,
    artifacts: ReadonlyArray<WorkflowActionArtifact>,
  ) => Effect.Effect<ReadonlyArray<ReadyToMergeItem>, IssueTrackerError>;
  readonly openPullRequestBranches: (
    workspace: RegisteredWorkspace,
  ) => Effect.Effect<ReadonlyArray<string>, IssueTrackerError>;
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

const unavailable = () =>
  Effect.fail(
    new IssueTrackerError({
      reason: "unavailable",
      retryable: false,
      message: "source control provider is not configured",
    }),
  );

export const emptyService: SourceControlProviderService = {
  workflowCatalogContribution: { entries: [], templates: [] },
  readyToMerge: () => Effect.succeed([]),
  openPullRequestBranches: () => Effect.succeed([]),
  resolvePullRequest: () => Effect.succeed(null),
  readPullRequest: () => Effect.succeed(null),
  openWorkflowPullRequest: unavailable,
  recordPullRequestPush: unavailable,
  commentPullRequest: unavailable,
  requestReview: unavailable,
  commentNamedPullRequest: unavailable,
  postReview: unavailable,
  draftReview: unavailable,
};

export const emptyLayer = Layer.succeed(SourceControlProvider, emptyService);
