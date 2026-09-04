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

export const WorkspaceBindingWorktreeConfig = WorktreeConfig;
export type WorkspaceBindingWorktreeConfig = typeof WorkspaceBindingWorktreeConfig.Type;

const workspaceUpdateFields = {
  name: TrimmedNonEmptyString,
  gitRemote: Schema.optional(TrimmedNonEmptyString),
  issueTracker: IssueTrackerConfig,
  sourceControl: Schema.optional(SourceControlConfig),
  mcpSkills: Schema.optional(Schema.Array(McpSkill)),
  linearHistory: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  worktrees: Schema.optional(WorkspaceBindingWorktreeConfig),
  concurrency: Schema.optional(WorkspaceConcurrency),
} as const;

export const WorkspaceUpdate = Schema.Struct(workspaceUpdateFields);
export type WorkspaceUpdate = typeof WorkspaceUpdate.Type;
export type WorkspaceUpdateInput = Schema.Codec.Encoded<typeof WorkspaceUpdate>;

export const WorkspaceRegistration = Schema.Struct({
  ...workspaceUpdateFields,
  checkoutPath: TrimmedNonEmptyString,
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
  worktrees: Schema.optional(WorktreeConfig),
  linearHistory: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});
export type WorkspaceConfig = typeof WorkspaceConfig.Type;
export type WorkspaceConfigInput = Schema.Codec.Encoded<typeof WorkspaceConfig>;
