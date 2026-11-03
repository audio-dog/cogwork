import type {
  PrSummary,
  ReadyToMergeItem,
  WorkflowActionArtifact,
  WorkflowActionOrigin,
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
  readonly resolvePullRequest: (
    workspace: RegisteredWorkspace,
    item: WorkItemRef,
  ) => Effect.Effect<ResolvedPullRequest | null, IssueTrackerError>;
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
}

export class SourceControlProvider extends Context.Service<
  SourceControlProvider,
  SourceControlProviderService
>()("@cogwork/engine/source-control/SourceControlProvider") {}

export const emptyService: SourceControlProviderService = {
  workflowCatalogContribution: { entries: [], templates: [] },
  readyToMerge: () => Effect.succeed([]),
  resolvePullRequest: () => Effect.succeed(null),
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
};

export const emptyLayer = Layer.succeed(SourceControlProvider, emptyService);
