import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IssueTrackerType, SourceControlType, TrimmedNonEmptyString, WorkspaceId } from "./base-schemas";
import { ConnectionBindingId } from "./connection";
import { McpSkill } from "./mcp-skill";

export const OAuthAppConfig = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  clientSecretEnv: Schema.optional(TrimmedNonEmptyString),
  redirectPort: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThan(65536))),
});
export type OAuthAppConfig = typeof OAuthAppConfig.Type;

export const GitHubIssueFieldId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("GitHubIssueFieldId"),
);
export type GitHubIssueFieldId = typeof GitHubIssueFieldId.Type;

export const GitHubPriorityField = Schema.Struct({
  id: GitHubIssueFieldId,
  name: TrimmedNonEmptyString,
});
export type GitHubPriorityField = typeof GitHubPriorityField.Type;

export const GitHubPrioritySource = Schema.Struct({ field: GitHubIssueFieldId });
export type GitHubPrioritySource = typeof GitHubPrioritySource.Type;

export const IssueTrackerConfig = Schema.Struct({
  type: IssueTrackerType,
  connectionId: ConnectionBindingId.pipe(Schema.withDecodingDefaultKey(Effect.succeed("unbound"))),
  teams: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1))),
  organization: Schema.optional(TrimmedNonEmptyString),
  assigneeAllowlist: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1))),
  botAllowlist: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1))),
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
  botAllowlist: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1))),
});
export type SourceControlConfig = typeof SourceControlConfig.Type;

export const OperationNeedKind = Schema.Literals(["mcp-server", "skill", "subagent", "hook", "connection"]);
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

export class WorkspaceRegistryError extends Schema.TaggedError<WorkspaceRegistryError>()(
  "WorkspaceRegistryError",
  {
    reason: Schema.Literals(["not-found", "management-failed"]),
    workspace: WorkspaceId,
    operation: Schema.optional(Schema.String),
    message: Schema.String,
  },
) {}

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
