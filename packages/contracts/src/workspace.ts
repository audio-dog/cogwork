import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IssueTrackerType, SourceControlType, TrimmedNonEmptyString, WorkspaceId } from "./base-schemas";
import { ConnectionBindingId } from "./connection";
import { McpSkill } from "./mcp-skill";

export const TriageRoleLabels = Schema.Struct({
  "needs-triage": Schema.optional(TrimmedNonEmptyString),
  "ready-for-agent": Schema.optional(TrimmedNonEmptyString),
  "needs-info": Schema.optional(TrimmedNonEmptyString),
  "ready-for-human": Schema.optional(TrimmedNonEmptyString),
  wontfix: Schema.optional(TrimmedNonEmptyString),
});
export type TriageRoleLabels = typeof TriageRoleLabels.Type;

export const OAuthAppConfig = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  clientSecretEnv: Schema.optional(TrimmedNonEmptyString),
  redirectPort: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThan(65536))),
});
export type OAuthAppConfig = typeof OAuthAppConfig.Type;

export const GitHubPrioritySource = Schema.Struct({
  project: Schema.Int.check(Schema.isGreaterThan(0)),
  field: Schema.optional(TrimmedNonEmptyString),
});
export type GitHubPrioritySource = typeof GitHubPrioritySource.Type;

export const IssueTrackerConfig = Schema.Struct({
  type: IssueTrackerType,
  connectionId: ConnectionBindingId.pipe(Schema.withDecodingDefaultKey(Effect.succeed("unbound"))),
  repo: Schema.optional(TrimmedNonEmptyString),
  teams: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1))),
  organization: Schema.optional(TrimmedNonEmptyString),
  actorLogin: Schema.optional(TrimmedNonEmptyString),
  actorUserId: Schema.optional(TrimmedNonEmptyString),
  assigneeAllowlist: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1))),
  botAllowlist: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1))),
  roleLabels: Schema.optional(TriageRoleLabels),
  priority: Schema.optional(GitHubPrioritySource),
});
export type IssueTrackerConfig = typeof IssueTrackerConfig.Type;

export const linearTeams = (source: IssueTrackerConfig) => {
  if (source.type !== "linear") return [];
  return [...new Set(source.teams ?? [])];
};

export const SourceControlConfig = Schema.Struct({
  type: SourceControlType,
  connectionId: ConnectionBindingId.pipe(Schema.withDecodingDefaultKey(Effect.succeed("unbound"))),
  repo: Schema.optional(TrimmedNonEmptyString),
  actorLogin: Schema.optional(TrimmedNonEmptyString),
  botAllowlist: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1))),
});
export type SourceControlConfig = typeof SourceControlConfig.Type;

export const OperationNeedKind = Schema.Literals([
  "mcp-server",
  "skill",
  "subagent",
  "command",
  "hook",
  "connection",
]);
export type OperationNeedKind = typeof OperationNeedKind.Type;

export const OperationNeed = Schema.Struct({
  name: TrimmedNonEmptyString,
  kind: OperationNeedKind,
});
export type OperationNeed = typeof OperationNeed.Type;
export const PlaybookStageConfig = Schema.Struct({
  prompt: Schema.optional(TrimmedNonEmptyString),
  skill: Schema.optional(TrimmedNonEmptyString),
  resumeMaxAgeMillis: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
  resumeMaxTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  needs: Schema.optional(Schema.Array(OperationNeed)),
});
export type PlaybookStageConfig = typeof PlaybookStageConfig.Type;

export const PlaybookConfig = Schema.Struct({
  triage: Schema.optional(PlaybookStageConfig),
  implement: Schema.optional(PlaybookStageConfig),
  "follow-up": Schema.optional(PlaybookStageConfig),
  verify: Schema.optional(PlaybookStageConfig),
});
export type PlaybookConfig = typeof PlaybookConfig.Type;

export const WorktreeConfig = Schema.Struct({
  root: Schema.optional(TrimmedNonEmptyString),
  remote: Schema.optional(TrimmedNonEmptyString),
  baseBranch: Schema.optional(TrimmedNonEmptyString),
  linkPaths: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  setup: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  reapAfterMillis: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
});
export type WorktreeConfig = typeof WorktreeConfig.Type;

export const WorkspaceConcurrency = Schema.Int.check(Schema.isGreaterThan(0));
export type WorkspaceConcurrency = typeof WorkspaceConcurrency.Type;

export const WorkspaceInputWorktreeConfig = Schema.Struct({
  linkPaths: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  setup: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type WorkspaceInputWorktreeConfig = typeof WorkspaceInputWorktreeConfig.Type;

export const WorkspaceBindingWorktreeConfig = Schema.Struct({
  root: Schema.optional(TrimmedNonEmptyString),
  remote: Schema.optional(TrimmedNonEmptyString),
  baseBranch: Schema.optional(TrimmedNonEmptyString),
  reapAfterMillis: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
});
export type WorkspaceBindingWorktreeConfig = typeof WorkspaceBindingWorktreeConfig.Type;

export const WorkspaceInput = Schema.Struct({
  mcpSkills: Schema.optional(Schema.Array(McpSkill)),
  playbook: Schema.optional(PlaybookConfig),
  worktrees: Schema.optional(WorkspaceInputWorktreeConfig),
});
export type WorkspaceInput = typeof WorkspaceInput.Type;

export const WorkspaceRegistration = Schema.Struct({
  name: TrimmedNonEmptyString,
  checkoutPath: TrimmedNonEmptyString,
  gitRemote: Schema.optional(TrimmedNonEmptyString),
  issueTracker: IssueTrackerConfig,
  sourceControl: Schema.optional(SourceControlConfig),
  linearHistory: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  worktrees: Schema.optional(WorkspaceBindingWorktreeConfig),
  concurrency: Schema.optional(WorkspaceConcurrency),
});
export type WorkspaceRegistration = typeof WorkspaceRegistration.Type;
export type WorkspaceRegistrationInput = Schema.Codec.Encoded<typeof WorkspaceRegistration>;

export class WorkspaceRegistrationError extends Schema.TaggedError<WorkspaceRegistrationError>()(
  "WorkspaceRegistrationError",
  { message: Schema.String },
) {}

export class WorkspaceManagementError extends Schema.TaggedError<WorkspaceManagementError>()(
  "WorkspaceManagementError",
  { operation: Schema.String, message: Schema.String },
) {}

export class WorkspaceNotFound extends Schema.TaggedError<WorkspaceNotFound>()("WorkspaceNotFound", {
  workspace: WorkspaceId,
}) {}

export const WorkspaceConfig = Schema.Struct({
  name: WorkspaceId,
  displayName: Schema.optional(TrimmedNonEmptyString),
  checkoutPath: TrimmedNonEmptyString,
  issueTracker: IssueTrackerConfig,
  sourceControl: Schema.optional(SourceControlConfig),
  mcpSkills: Schema.optional(Schema.Array(McpSkill)),
  playbook: Schema.optional(PlaybookConfig),
  worktrees: Schema.optional(WorktreeConfig),
  linearHistory: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});
export type WorkspaceConfig = typeof WorkspaceConfig.Type;
export type WorkspaceConfigInput = Schema.Codec.Encoded<typeof WorkspaceConfig>;
