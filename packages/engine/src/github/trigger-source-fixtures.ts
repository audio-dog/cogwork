import {
  GitHubIssueFieldId,
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
  WorkItemId,
  WorkspaceConfig,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { RegisteredWorkspace, RegistryState } from "../projector";
import { makeTrackerTriggerSource } from "../tracker-trigger-source";
import type { TriggerSubscription } from "../trigger-source";
import type { WorkflowArtifactStoreService } from "../workflow-artifact-store";
import { GitHubClient, type GitHubClientService, type GitHubRepoRef, type RawPull } from "./client";
import { makeIssueReads } from "./host";

export const issueHasLabelKey = Schema.decodeSync(WorkflowCatalogKey)("github.issue-has-label");
export const newIssueCommentKey = Schema.decodeSync(WorkflowCatalogKey)("github.new-comment-from-person");
export const githubTrackerInstance = (
  client: GitHubClientService,
  registry: Effect.Effect<RegistryState>,
  artifacts: WorkflowArtifactStoreService | null = null,
) => makeTrackerTriggerSource("github", makeIssueReads(client), registry, artifacts);

export const workspaceId = Schema.decodeSync(WorkspaceId)("github-workspace");
export const workspace: RegisteredWorkspace = {
  source: "test",
  repository: "acme/example",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    id: workspaceId,
    displayName: "Test workspace",
    checkoutPath: "/repos/example",
    issueTracker: { type: "github" },
  }),
};
export const registryState = { workspaces: [workspace], failures: [] };
const botWorkspace: RegisteredWorkspace = {
  ...workspace,
  config: Schema.decodeSync(WorkspaceConfig)({
    id: workspaceId,
    displayName: "Test workspace",
    checkoutPath: "/repos/example",
    issueTracker: { type: "github" },
    sourceControl: { type: "github", botAllowlist: ["maintainer"] },
  }),
};
export const botRegistryState = { workspaces: [botWorkspace], failures: [] };
export const prioritizedWorkspace: RegisteredWorkspace = {
  ...workspace,
  config: Schema.decodeSync(WorkspaceConfig)({
    id: workspaceId,
    displayName: "Test workspace",
    checkoutPath: "/repos/example",
    issueTracker: { type: "github", priority: { field: 42 } },
  }),
};
export const priorityFieldId = Schema.decodeSync(GitHubIssueFieldId)(42);
export const workflow = Schema.decodeSync(WorkflowId)("coding");
const operation = Schema.decodeSync(WorkflowNodeId)("follow-up");
export const reviewTrigger = Schema.decodeSync(WorkflowNodeId)("review");
export const issueNotBlockedKey = Schema.decodeSync(WorkflowCatalogKey)("github.issue-not-blocked");
export const firstIssueId = Schema.decodeSync(WorkItemId)("#1");
export const secondIssueId = Schema.decodeSync(WorkItemId)("#2");
export const thirdIssueId = Schema.decodeSync(WorkItemId)("#3");
export const subscription = (
  entry: string,
  trigger: string,
  parameters: TriggerSubscription["parameters"] = [],
  since = 1_000,
): TriggerSubscription => ({
  workflow,
  trigger: Schema.decodeSync(WorkflowNodeId)(trigger),
  operation,
  entry: Schema.decodeSync(WorkflowCatalogKey)(entry),
  parameters,
  filters: [],
  workspaces: [workspaceId],
  catchUp: { since },
});

export const issue = (number: number, isPullRequest = false) => ({
  nodeId: `issue-${number}`,
  number,
  title: `Issue ${number}`,
  url: `https://github.com/acme/example/issues/${number}`,
  labels: ["needs-triage"],
  assignees: ["maintainer"],
  isPullRequest,
  openBlockers: 0,
  body: "Body",
  state: "open" as const,
  createdAtMillis: number,
  updatedAtMillis: number + 3_000,
});

export const issueReads = {
  readIssue: (_target: GitHubRepoRef, number: number) => Effect.succeed(issue(number)),
  listTriggerComments: () => Effect.succeed([]),
} satisfies Partial<GitHubClientService>;

export const trustedPull: RawPull = {
  number: 10,
  url: "https://github.com/acme/example/pull/10",
  authorLogin: "maintainer",
  authorAssociation: "MEMBER",
  draft: false,
  headSha: "head-sha",
  baseSha: "base-sha",
  baseRef: "main",
  headRef: "7-work",
  headRepository: "acme/example",
  closingIssueNumbers: [7],
  updatedAtMillis: 3_000,
};

const pulls: Array<RawPull> = [
  {
    number: 11,
    url: "https://github.com/acme/example/pull/11",
    authorLogin: "outside-user",
    authorAssociation: "NONE",
    draft: false,
    headSha: "outside-sha",
    baseSha: "base-sha",
    headRef: "99-work",
    headRepository: "outside/fork",
    closingIssueNumbers: [99],
    updatedAtMillis: 2_900,
  },
  trustedPull,
];

export const pullDetail = (number: number, mergeableState: string) => ({
  ...trustedPull,
  number,
  baseSha: trustedPull.baseSha,
  baseRef: trustedPull.baseRef,
  title: `Pull request ${number}`,
  body: "Pull request description",
  mergeableState,
});

export const pullClientLayer = (listedPulls = pulls) =>
  Layer.mock(GitHubClient, {
    authenticatedLogin: () => Effect.succeed("cogwork[bot]"),
    listPulls: () => Effect.succeed(listedPulls),
    listCheckRuns: () =>
      Effect.succeed([
        {
          name: "test",
          status: "completed",
          conclusion: "failure",
          startedAtMillis: 2_500,
          detailsUrl: "https://github.com/acme/example/actions/runs/1",
          outputTitle: "1 test failed",
          outputSummary: "expected 1 to equal 2",
        },
      ]),
    getPull: (_target, number) => Effect.succeed(pullDetail(number, "dirty")),
    listPullFiles: () =>
      Effect.succeed([
        {
          path: "src/index.ts",
          status: "modified",
          additions: 3,
          deletions: 1,
          changes: 4,
          patch: "+secret patch",
        },
      ]),
    listTriggerComments: () => Effect.succeed([]),
    listReviewComments: () => Effect.succeed([]),
    listReviews: () =>
      Effect.succeed([
        {
          id: 88,
          authorLogin: "maintainer",
          authorAssociation: "MEMBER",
          authorType: "User",
          state: "COMMENTED",
          body: "Review body",
          submittedAtMillis: 2_800,
        },
      ]),
  });

export const targetOf = (event: object) => ("target" in event ? event.target : undefined);
