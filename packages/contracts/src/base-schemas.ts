import * as Schema from "effect/Schema";

export const TrimmedString = Schema.Trim;

export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

export const makeBrand = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const WorkspaceId = makeBrand("WorkspaceId");
export type WorkspaceId = typeof WorkspaceId.Type;

export const WorkItemId = makeBrand("WorkItemId");
export type WorkItemId = typeof WorkItemId.Type;

export const BranchName = makeBrand("BranchName");
export type BranchName = typeof BranchName.Type;

export const GitCommitSha = makeBrand("GitCommitSha").check(Schema.isPattern(/^[0-9a-f]{40}$/i));
export type GitCommitSha = typeof GitCommitSha.Type;

export const GitHubWorkflowRunUrl = makeBrand("GitHubWorkflowRunUrl").check(
  Schema.isPattern(
    /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+\/actions\/runs\/[1-9]\d*$/,
  ),
);
export type GitHubWorkflowRunUrl = typeof GitHubWorkflowRunUrl.Type;

export const HarnessName = makeBrand("HarnessName");
export type HarnessName = typeof HarnessName.Type;

export const IssueTrackerType = makeBrand("IssueTrackerType");
export type IssueTrackerType = typeof IssueTrackerType.Type;

export const SourceControlType = makeBrand("SourceControlType");
export type SourceControlType = typeof SourceControlType.Type;
