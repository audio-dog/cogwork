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
import * as Schema from "effect/Schema";
import type { RegisteredWorkspace, RegistryState } from "../projector";
import { makeTrackerTriggerSource } from "../tracker-trigger-source";
import type { TriggerSubscription } from "../trigger-source";
import type { WorkflowArtifactStoreService } from "../workflow-artifact-store";
import type { GitHubClientService, GitHubRepoRef } from "./client";
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
    name: workspaceId,
    checkoutPath: "/repos/example",
    issueTracker: { type: "github" },
  }),
};
export const registryState = { workspaces: [workspace], failures: [] };
export const prioritizedWorkspace: RegisteredWorkspace = {
  ...workspace,
  config: Schema.decodeSync(WorkspaceConfig)({
    name: workspaceId,
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
