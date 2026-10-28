import type { WorkItem, WorkItemId } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ObservedPr } from "./follow-up";
import { IssueTrackerError } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import type { TriggerSource } from "./trigger-source";

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

export interface SourceControlProviderService {
  readonly triggerSources?: ReadonlyArray<TriggerSource>;
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
}

export class SourceControlProvider extends Context.Service<
  SourceControlProvider,
  SourceControlProviderService
>()("@cogwork/engine/source-control/SourceControlProvider") {}

const noProvider: SourceControlProviderService = {
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
};

// The binding for a workspace with no source control provider — a Linear tracker with no
// `sourceControl` block. It reports no pull request for any item.
export const emptyLayer = Layer.succeed(SourceControlProvider, noProvider);
