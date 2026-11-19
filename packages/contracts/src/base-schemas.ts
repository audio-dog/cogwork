import * as Schema from "effect/Schema";

export const TrimmedString = Schema.Trim;

export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

export const makeBrand = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) =>
  TrimmedNonEmptyString.pipe(Schema.brand<Brand>(brand));

export const WorkspaceId = makeBrand("WorkspaceId");
export type WorkspaceId = typeof WorkspaceId.Type;

export const WorkflowId = makeBrand("WorkflowId");
export type WorkflowId = typeof WorkflowId.Type;

export const WorkItemId = makeBrand("WorkItemId");
export type WorkItemId = typeof WorkItemId.Type;

export const BranchName = makeBrand("BranchName");
export type BranchName = typeof BranchName.Type;

export const HarnessName = makeBrand("HarnessName");
export type HarnessName = typeof HarnessName.Type;

export const IssueTrackerType = makeBrand("IssueTrackerType");
export type IssueTrackerType = typeof IssueTrackerType.Type;

export const SourceControlType = makeBrand("SourceControlType");
export type SourceControlType = typeof SourceControlType.Type;

export const SlackTeamId = makeBrand("SlackTeamId");
export type SlackTeamId = typeof SlackTeamId.Type;

export const SlackChannelId = makeBrand("SlackChannelId");
export type SlackChannelId = typeof SlackChannelId.Type;

export const SlackMessageTs = makeBrand("SlackMessageTs");
export type SlackMessageTs = typeof SlackMessageTs.Type;

export const SlackWriteKey = makeBrand("SlackWriteKey");
export type SlackWriteKey = typeof SlackWriteKey.Type;
